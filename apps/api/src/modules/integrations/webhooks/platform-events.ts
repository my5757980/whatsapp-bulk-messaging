import { Injectable } from '@nestjs/common';
import { eventContact, eventMessage, type EventType } from '@wbm/shared';
import type { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { OutboundEvents } from './outbound-events.js';

// Typed event writers for each event source (feature 006, research R3, contracts/webhook-events.md).
// Each call runs inside the source's own transaction and does nothing when no endpoint chose the
// type, so a source pays one cached lookup unless someone listens.

type Db = Prisma.TransactionClient | PrismaService;

const CONTACT_SELECT = { id: true, phoneE164: true, name: true } as const;

export interface StatusLike {
  status: string;
  timestamp: Date;
  error?: { code: number | undefined; message: string | undefined } | undefined;
}

@Injectable()
export class PlatformEvents {
  constructor(private readonly events: OutboundEvents) {}

  private async contact(db: Db, contactId: string | null | undefined) {
    if (!contactId) return null;
    return eventContact(await db.contact.findUnique({ where: { id: contactId }, select: CONTACT_SELECT }));
  }

  private async when(type: EventType, build: () => Promise<Record<string, unknown> | null>, db: Db, occurredAt?: Date): Promise<void> {
    if (!(await this.events.listens(type, db))) return;
    const data = await build();
    if (data) await this.events.record(db, type, data, occurredAt);
  }

  listens(type: EventType): Promise<boolean> {
    return this.events.listens(type);
  }

  /** A template message's status (001 statuses for campaigns, API, drips and store messages). */
  messageStatus(db: Db, messageId: string, status: StatusLike): Promise<void> {
    return this.when(
      'message.status',
      async () => {
        const m = await db.message.findUnique({
          where: { id: messageId },
          select: {
            id: true,
            waMessageId: true,
            origin: true,
            campaignId: true,
            apiCampaignId: true,
            dripStep: { select: { dripId: true } },
            template: { select: { name: true } },
            contact: { select: CONTACT_SELECT },
          },
        });
        if (!m) return null;
        return {
          message: eventMessage({
            id: m.id,
            waMessageId: m.waMessageId,
            origin: m.origin,
            campaignId: m.campaignId,
            apiCampaignId: m.apiCampaignId,
            dripId: m.dripStep?.dripId ?? null,
            templateName: m.template.name,
          }),
          contact: eventContact(m.contact),
          status: status.status,
          failure: status.error?.code !== undefined ? { code: status.error.code, title: status.error.message ?? null } : null,
          statusAt: status.timestamp.toISOString(),
        };
      },
      db,
      status.timestamp,
    );
  }

  /** The status of a free-form live chat reply (002). */
  chatReplyStatus(db: Db, chatMessageId: string, status: StatusLike): Promise<void> {
    return this.when(
      'message.status',
      async () => {
        const item = await db.chatMessage.findUnique({ where: { id: chatMessageId }, select: { id: true, waMessageId: true, conversation: { select: { contact: { select: CONTACT_SELECT } } } } });
        if (!item) return null;
        return {
          message: eventMessage({ id: item.id, waMessageId: item.waMessageId, origin: 'LIVE_CHAT', campaignId: null, apiCampaignId: null, dripId: null, templateName: null }),
          contact: eventContact(item.conversation.contact),
          status: status.status,
          failure: status.error?.code !== undefined ? { code: status.error.code, title: status.error.message ?? null } : null,
          statusAt: status.timestamp.toISOString(),
        };
      },
      db,
      status.timestamp,
    );
  }

  /** A customer message reached live chat (002); content is removed later for endpoints that chose so. */
  messageReceived(
    db: Db,
    input: { chatMessageId: string; waMessageId: string | null; conversationId: string; numberId: string; contactId: string | null; type: string; text?: string | null; caption?: string | null; buttonPayload?: string | null; at: Date },
  ): Promise<void> {
    return this.when(
      'message.received',
      async () => ({
        message: { id: input.chatMessageId, waMessageId: input.waMessageId, type: input.type },
        contact: await this.contact(db, input.contactId),
        conversationId: input.conversationId,
        numberId: input.numberId,
        ...(input.text ? { text: input.text } : {}),
        ...(input.caption ? { caption: input.caption } : {}),
        ...(input.buttonPayload ? { buttonPayload: input.buttonPayload } : {}),
      }),
      db,
      input.at,
    );
  }

  contactCreated(db: Db, contactId: string, source: string, extra: { tags?: string[]; attributes?: Record<string, unknown> } = {}): Promise<void> {
    return this.when('contact.created', async () => ({ contact: await this.contact(db, contactId), source, tags: extra.tags ?? [], attributes: extra.attributes ?? {} }), db);
  }

  contactUpdated(db: Db, contactId: string, changed: string[]): Promise<void> {
    if (!changed.length) return Promise.resolve();
    return this.when('contact.updated', async () => ({ contact: await this.contact(db, contactId), changed }), db);
  }

  /** Only the id: the person's details are gone (FR-060). */
  contactDeleted(db: Db, contactId: string): Promise<void> {
    return this.when('contact.deleted', () => Promise.resolve({ contact: { id: contactId } }), db);
  }

  tagsChanged(db: Db, contactId: string, added: string[], removed: string[]): Promise<void> {
    if (!added.length && !removed.length) return Promise.resolve();
    return this.when('contact.tags_changed', async () => ({ contact: await this.contact(db, contactId), added, removed }), db);
  }

  optedIn(db: Db, contactId: string, source: string, note: string | null): Promise<void> {
    return this.when('contact.opted_in', async () => ({ contact: await this.contact(db, contactId), source, note }), db);
  }

  optedOut(db: Db, contactId: string, source: string): Promise<void> {
    return this.when('contact.opted_out', async () => ({ contact: await this.contact(db, contactId), source }), db);
  }

  /** A call to an API campaign, sent or refused (feature 006 US3, FR-019). */
  apiCampaignTriggered(
    db: Db,
    input: { campaign: { id: string; name: string; apiName: string }; contactId: string | null; outcome: 'QUEUED' | 'NOT_SENT'; reason: string | null; messageId: string | null },
  ): Promise<void> {
    return this.when(
      'api_campaign.triggered',
      async () => ({ apiCampaign: input.campaign, contact: await this.contact(db, input.contactId), outcome: input.outcome, reason: input.reason, messageId: input.messageId }),
      db,
    );
  }

  /** A store order notification, COD question or cart reminder was queued (feature 006 US4 - US6). */
  storeNotificationSent(
    db: Db,
    input: { store: { id: string; name: string; platform: string }; order: { id: string; number: string }; kind: string; contactId: string; messageId: string },
  ): Promise<void> {
    return this.when(
      'store.notification_sent',
      async () => ({ store: input.store, order: input.order, kind: input.kind, contact: await this.contact(db, input.contactId), messageId: input.messageId }),
      db,
    );
  }

  linkClicked(db: Db, input: { contactId: string | null; campaignId: string | null; dripId: string | null; destination: string; device: string; at: Date }): Promise<void> {
    return this.when(
      'link.clicked',
      async () => ({ contact: await this.contact(db, input.contactId), campaignId: input.campaignId, dripId: input.dripId, destination: input.destination, device: input.device, clickedAt: input.at.toISOString() }),
      db,
      input.at,
    );
  }

  /** Contacts that joined a drip, in bulk (enrolling by hand or from starting events). */
  async dripJoined(db: Db, dripId: string, joins: Array<{ contactId: string | null; via: string }>): Promise<void> {
    if (!joins.length || !(await this.events.listens('drip.joined', db))) return;
    const drip = await db.drip.findUnique({ where: { id: dripId }, select: { id: true, name: true } });
    if (!drip) return;
    const contacts = await this.contactsById(db, joins.flatMap((j) => (j.contactId ? [j.contactId] : [])));
    for (const join of joins) await this.events.record(db, 'drip.joined', { contact: join.contactId ? (contacts.get(join.contactId) ?? null) : null, drip, via: join.via });
  }

  dripFinished(db: Db, dripId: string, contactId: string | null): Promise<void> {
    return this.when('drip.finished', async () => ({ contact: await this.contact(db, contactId), drip: await db.drip.findUnique({ where: { id: dripId }, select: { id: true, name: true } }) }), db);
  }

  dripLeft(db: Db, dripId: string, contactId: string | null, reason: string): Promise<void> {
    return this.when('drip.left', async () => ({ contact: await this.contact(db, contactId), drip: await db.drip.findUnique({ where: { id: dripId }, select: { id: true, name: true } }), reason }), db);
  }

  /** A member took a chat or it was transferred (002); by: member, rule, flow or ai. */
  chatAssigned(db: Db, conversationId: string, assigneeId: string | null, by: string): Promise<void> {
    return this.when(
      'chat.assigned',
      async () => {
        const chat = await db.conversation.findUnique({ where: { id: conversationId }, select: { id: true, numberId: true, contactId: true } });
        if (!chat) return null;
        const assignee = assigneeId ? await db.user.findUnique({ where: { id: assigneeId }, select: { id: true, name: true } }) : null;
        return { conversationId, contact: await this.contact(db, chat.contactId), numberId: chat.numberId, assignee, by };
      },
      db,
    );
  }

  /** A chat was closed by a member, or automatically (closedById null). */
  chatClosed(db: Db, conversationId: string, closedById: string | null): Promise<void> {
    return this.when(
      'chat.closed',
      async () => {
        const chat = await db.conversation.findUnique({ where: { id: conversationId }, select: { id: true, numberId: true, contactId: true } });
        if (!chat) return null;
        const closedBy = closedById ? await db.user.findUnique({ where: { id: closedById }, select: { id: true, name: true } }) : null;
        return { conversationId, contact: await this.contact(db, chat.contactId), numberId: chat.numberId, closedBy };
      },
      db,
    );
  }

  /** Any other catalog event with a ready payload (API campaigns, stores). */
  raw(db: Db, type: EventType, data: Record<string, unknown>): Promise<void> {
    return this.when(type, () => Promise.resolve(data), db);
  }

  // ---- Bulk writers (imports, bulk actions, starting events): one contact query per batch ----

  private async contactsById(db: Db, ids: readonly string[]) {
    const rows = ids.length ? await db.contact.findMany({ where: { id: { in: [...new Set(ids)] } }, select: CONTACT_SELECT }) : [];
    return new Map(rows.map((c) => [c.id, eventContact(c)]));
  }

  async contactsCreated(db: Db, contactIds: readonly string[], source: string): Promise<void> {
    if (!contactIds.length || !(await this.events.listens('contact.created', db))) return;
    const contacts = await this.contactsById(db, contactIds);
    for (const id of contactIds) await this.events.record(db, 'contact.created', { contact: contacts.get(id) ?? { id, phone: null, name: null }, source, tags: [], attributes: {} });
  }

  async contactsUpdated(db: Db, contactIds: readonly string[], changed: string[]): Promise<void> {
    if (!contactIds.length || !changed.length || !(await this.events.listens('contact.updated', db))) return;
    const contacts = await this.contactsById(db, contactIds);
    for (const id of contactIds) await this.events.record(db, 'contact.updated', { contact: contacts.get(id) ?? { id, phone: null, name: null }, changed });
  }

  /** Tag links added or removed, by tag id, for many contacts (one event per contact). */
  async tagLinksChanged(db: Db, added: ReadonlyArray<{ contactId: string; tagId: string }>, removed: ReadonlyArray<{ contactId: string; tagId: string }> = []): Promise<void> {
    if ((!added.length && !removed.length) || !(await this.events.listens('contact.tags_changed', db))) return;
    const tagIds = [...new Set([...added, ...removed].map((l) => l.tagId))];
    const names = new Map((await db.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    const byContact = new Map<string, { added: string[]; removed: string[] }>();
    for (const l of added) {
      const entry = byContact.get(l.contactId) ?? { added: [], removed: [] };
      entry.added.push(names.get(l.tagId) ?? l.tagId);
      byContact.set(l.contactId, entry);
    }
    for (const l of removed) {
      const entry = byContact.get(l.contactId) ?? { added: [], removed: [] };
      entry.removed.push(names.get(l.tagId) ?? l.tagId);
      byContact.set(l.contactId, entry);
    }
    const contacts = await this.contactsById(db, [...byContact.keys()]);
    for (const [id, change] of byContact) await this.events.record(db, 'contact.tags_changed', { contact: contacts.get(id) ?? { id, phone: null, name: null }, ...change });
  }

  async optedInMany(db: Db, items: ReadonlyArray<{ contactId: string; note: string | null }>, source: string): Promise<void> {
    if (!items.length || !(await this.events.listens('contact.opted_in', db))) return;
    const contacts = await this.contactsById(db, items.map((i) => i.contactId));
    for (const item of items) await this.events.record(db, 'contact.opted_in', { contact: contacts.get(item.contactId) ?? null, source, note: item.note });
  }
}
