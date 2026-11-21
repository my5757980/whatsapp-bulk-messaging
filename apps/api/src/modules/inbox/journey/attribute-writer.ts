import { Logger } from '@nestjs/common';
import type { Prisma } from '../../../generated/prisma/client.js';
import { validateAttributeValue, type AttributeValue } from '../../contacts/attribute-validator.js';

type Tx = Prisma.TransactionClient;

/** The automation that sets the values; it becomes the actor of the journey entries. */
export type AttributeAuthor = { type: 'FLOW'; flowId: string; flowName: string } | { type: 'AI_AGENT'; agentId: string; agentName: string };

const logger = new Logger('AttributeWriter');

/**
 * Writes contact attributes for automations (003 flows, 004 AI agents; T068): only attributes that
 * are defined, values checked against the attribute's type, and an ATTRIBUTE_CHANGED journey entry in
 * each of the contact's chats with the automation as the actor. Runs in the caller's transaction and
 * returns the keys that changed (empty when nothing did).
 */
export async function writeAttributes(tx: Tx, contactId: string, values: Record<string, string | number | null>, author: AttributeAuthor): Promise<string[]> {
  const keys = Object.keys(values);
  if (!keys.length) return [];
  const [definitions, contact] = await Promise.all([
    tx.attributeDefinition.findMany({ where: { key: { in: keys } }, select: { key: true, type: true } }),
    tx.contact.findUnique({ where: { id: contactId }, select: { attributes: true } }),
  ]);
  if (!contact) return [];
  const typeOf = new Map(definitions.map((d) => [d.key, d.type]));
  const attributes = { ...((contact.attributes ?? {}) as Record<string, unknown>) };
  const changes: Array<{ key: string; from: unknown; to: AttributeValue | null }> = [];
  for (const [key, raw] of Object.entries(values)) {
    const type = typeOf.get(key);
    const checked = type && raw !== null ? validateAttributeValue(type, raw) : null;
    if (!type || (checked && !checked.ok)) {
      logger.warn({ contactId, attribute: key, by: author.type }, 'Value does not fit the contact attribute; not saved');
      continue;
    }
    const to = checked?.ok ? checked.value : null;
    const from = attributes[key] ?? null;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    if (to === null) delete attributes[key];
    else attributes[key] = to;
    changes.push({ key, from, to });
  }
  if (!changes.length) return [];
  await tx.contact.update({ where: { id: contactId }, data: { attributes: attributes as Prisma.InputJsonValue } });
  const chats = await tx.conversation.findMany({ where: { contactId }, select: { id: true } });
  const occurredAt = new Date();
  const who = author.type === 'FLOW' ? { flowId: author.flowId, flowName: author.flowName } : { agentId: author.agentId, agentName: author.agentName };
  await tx.conversationEvent.createMany({
    data: changes.flatMap((change) =>
      chats.map((chat) => ({
        conversationId: chat.id,
        type: 'ATTRIBUTE_CHANGED' as const,
        actorType: author.type,
        data: { key: change.key, from: change.from, to: change.to, ...who } as Prisma.InputJsonValue,
        occurredAt,
      })),
    ),
  });
  return changes.map((c) => c.key);
}
