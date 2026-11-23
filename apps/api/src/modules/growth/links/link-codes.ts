import { randomInt } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { makeLinkCode, trackedLinkUrl } from '@wbm/shared';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import type { Prisma } from '../../../generated/prisma/client.js';

// Per-recipient codes (feature 005, FR-002, research R2): 10 random characters drawn with
// crypto.randomInt, unique in the database and carrying no data.

export interface PlannedLink {
  code: string;
  targetId: string;
  messageId: string;
  contactId: string | null;
}

/** A code for previews and estimates; real codes are made at launch. */
const SAMPLE_CODE = 'AbCdEf1234';
const ATTEMPTS = 5;

@Injectable()
export class TrackedLinkCodes {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  newCode(): string {
    return makeLinkCode((max) => randomInt(max));
  }

  /** What a tracked variable carries: the code in a URL button (its address ends with the code), the whole short link in text. */
  valueFor(variableKey: string, code: string): string {
    return variableKey.startsWith('BUTTON.') ? code : trackedLinkUrl(this.config.PUBLIC_LINK_BASE_URL ?? '', code);
  }

  /** The value previews show for a tracked variable. */
  sampleValue(variableKey: string): string {
    return this.valueFor(variableKey, SAMPLE_CODE);
  }

  /** New codes for each message and tracked variable, with the parameters the messages must carry. */
  plan(
    messages: ReadonlyArray<{ id: string; contactId: string | null }>,
    targets: ReadonlyArray<{ id: string; variableKey: string }>,
  ): { links: PlannedLink[]; params: Map<string, Record<string, string>> } {
    const links: PlannedLink[] = [];
    const params = new Map<string, Record<string, string>>();
    for (const message of messages) {
      const values: Record<string, string> = {};
      for (const target of targets) {
        const code = this.newCode();
        links.push({ code, targetId: target.id, messageId: message.id, contactId: message.contactId });
        values[target.variableKey] = this.valueFor(target.variableKey, code);
      }
      params.set(message.id, values);
    }
    return { links, params };
  }

  /**
   * Stores planned links inside the caller's transaction. A message that already has a link for a
   * target keeps it; a code someone else already holds is drawn again, and the message's parameters
   * follow the new code.
   */
  async save(tx: Prisma.TransactionClient, links: PlannedLink[], targets: ReadonlyArray<{ id: string; variableKey: string }>): Promise<void> {
    const keyOf = new Map(targets.map((t) => [t.id, t.variableKey]));
    let pending = links;
    for (let attempt = 0; pending.length && attempt < ATTEMPTS; attempt += 1) {
      const inserted = await tx.trackedLink.createManyAndReturn({ data: pending, skipDuplicates: true, select: { messageId: true, targetId: true } });
      if (inserted.length === pending.length) return;
      const done = new Set(inserted.map((r) => `${r.messageId}:${r.targetId}`));
      const missed = pending.filter((l) => !done.has(`${l.messageId}:${l.targetId}`));
      const existing = await tx.trackedLink.findMany({
        where: { OR: missed.map((l) => ({ messageId: l.messageId, targetId: l.targetId })) },
        select: { messageId: true, targetId: true },
      });
      const kept = new Set(existing.map((r) => `${r.messageId}:${r.targetId}`));
      pending = missed.filter((l) => !kept.has(`${l.messageId}:${l.targetId}`)).map((l) => ({ ...l, code: this.newCode() }));
      for (const link of pending) {
        const patch = JSON.stringify({ [keyOf.get(link.targetId) ?? '']: this.valueFor(keyOf.get(link.targetId) ?? '', link.code) });
        await tx.$executeRaw`UPDATE messages SET resolved_params = resolved_params || ${patch}::jsonb WHERE id = ${link.messageId}::uuid`;
      }
    }
    if (pending.length) throw new Error('Could not draw unique tracked-link codes');
  }
}
