import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry, REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { Prisma } from '../../../generated/prisma/client.js';
import { INBOX_QUEUE, readReceiptJob } from '../inbox-queue.js';
import { ChatTimelineService } from '../messages/chat-timeline.service.js';
import { ChatRoutingService } from '../routing/chat-routing.service.js';
import { InboxPublisher, type PreviousFacts } from '../realtime/inbox-publisher.js';
import { AgentRulesLoader } from './agent-rules.loader.js';
import { resolve as resolveTransition, transfer as transferTransition } from './conversation-state.js';
import {
  decodeCursor,
  encodeCursor,
  factsOf,
  SUMMARY_INCLUDE,
  toSummaryDto,
  type ConversationRow,
  type ConversationSummaryDto,
} from './conversation-views.js';
import { canAccess, seesAll, visibleSql, type Viewer } from './visibility.js';
import { isLive } from './window.js';

export const ConversationListQuerySchema = z.object({
  view: z.enum(['live', 'history']).default('live'),
  state: z.enum(['ACTIVE', 'REQUESTING', 'INTERVENED']).optional(),
  mine: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  numberId: z.uuid().optional(),
  tagId: z.uuid().optional(),
  attribute: z
    .string()
    .max(200)
    .regex(/^[^:]+:.*$/, 'use key:value')
    .optional(),
  campaignId: z.uuid().optional(),
  q: z.string().trim().max(100).optional(),
  cursor: z.string().max(300).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});
export type ConversationListQuery = z.infer<typeof ConversationListQuerySchema>;

/** POST /inbox/conversations: open (or create) the chat with a contact on a number. */
export const OpenConversationSchema = z.strictObject({ contactId: z.uuid(), numberId: z.uuid() });
export type OpenConversationInput = z.infer<typeof OpenConversationSchema>;

export const TransferSchema = z.strictObject({ userId: z.uuid() });
export type TransferInput = z.infer<typeof TransferSchema>;

/** Unread totals are cached briefly per user and dropped when that user reads a chat (R8). */
const UNREAD_CACHE_SECONDS = 10;
const unreadKey = (userId: string) => `wbm:inbox:unread:${userId}`;
/** At most one read receipt per chat per 10 s (R11). */
const READ_RECEIPT_GAP_SECONDS = 10;

/** SQL: the chat is live (window open) and its contact is not blocked. */
const LIVE_SQL = Prisma.sql`(COALESCE(c.last_customer_message_at > now() - interval '24 hours', false) AND k.blocked_at IS NULL)`;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (ch) => `\\${ch}`);

/**
 * Chat lists, detail and the take / close / read actions (US1, FR-001, FR-019, FR-023, FR-026-FR-028,
 * research R6-R8). A chat the caller may not see answers 404.
 */
@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: AgentRulesLoader,
    private readonly publisher: InboxPublisher,
    private readonly queues: QueueRegistry,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly timeline: ChatTimelineService,
    private readonly routing: ChatRoutingService,
  ) {}

  /** Hands a taken chat to another member who may see it (FR-022): the owner, or an admin or manager. */
  async transfer(viewer: Viewer & { name: string }, id: string, input: TransferInput): Promise<ConversationSummaryDto> {
    const row = await this.loadVisible(viewer, id);
    const transition = transferTransition({ state: row.state, intervenedById: row.intervenedById }, { id: viewer.id, canMonitor: seesAll(viewer) }, input.userId);
    if (!transition.ok) {
      throw AppError.conflict(
        transition.error === 'NOT_INTERVENED' ? 'Nobody has taken this chat, so it cannot be transferred' : 'Only the member who took this chat, an admin or a manager can transfer it',
        transition.error,
      );
    }
    if (!transition.changed) return this.summaryFor(viewer, id);
    const target = await this.prisma.user.findUnique({ where: { id: input.userId }, select: { id: true, role: true, status: true } });
    if (!target) throw AppError.notFound('Member not found');
    // The new owner must be active and allowed to see this contact (agent rules), as if the chat were open.
    const targetRules = seesAll(target) ? [] : await this.rules.forUser(target.id);
    if (target.status !== 'ACTIVE' || !can(target.role, 'inbox.reply') || !canAccess(target, targetRules, { ...factsOf(row), state: 'ACTIVE', intervenedById: null })) {
      throw AppError.conflict('That member cannot see this chat', 'TARGET_CANNOT_SEE');
    }
    const now = new Date();
    const moved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.conversation.updateMany({
        where: { id, state: 'INTERVENED', intervenedById: row.intervenedById },
        data: { intervenedById: target.id, intervenedAt: now },
      });
      if (!updated.count) return false;
      await tx.conversationEvent.create({
        data: { conversationId: id, type: 'TRANSFERRED', actorType: 'MEMBER', actorUserId: viewer.id, occurredAt: now, data: { fromUserId: row.intervenedById, toUserId: target.id } },
      });
      return true;
    });
    if (!moved) throw AppError.conflict('The chat changed meanwhile; refresh and try again', 'CONFLICT');
    await this.publisher.conversation(id, previous(row));
    await this.routing.alertTransferred(id, target.id, viewer.name);
    return this.summaryFor(viewer, id);
  }

  /**
   * Opens the chat with a contact on a number, creating it when needed (US2, "Message on
   * WhatsApp"): a new chat starts Active, in Past chats until the customer writes, with the
   * templates already sent to the contact on that number in its timeline.
   */
  async openOrCreate(viewer: Viewer, input: OpenConversationInput): Promise<{ created: boolean; summary: ConversationSummaryDto }> {
    const [contact, number] = await Promise.all([
      this.prisma.contact.findUnique({ where: { id: input.contactId }, select: { id: true, attributes: true, blockedAt: true, tags: { select: { tagId: true } } } }),
      this.prisma.whatsAppNumber.findUnique({ where: { id: input.numberId }, select: { id: true } }),
    ]);
    if (!contact || !number) throw AppError.notFound('Contact or number not found');
    const key = { contactId_numberId: { contactId: contact.id, numberId: number.id } };
    const existing = await this.prisma.conversation.findUnique({ where: key, select: { id: true } });
    if (existing) {
      await this.loadVisible(viewer, existing.id);
      return { created: false, summary: await this.summaryFor(viewer, existing.id) };
    }
    // Agents may only start chats their rules let them see.
    const rules = seesAll(viewer) ? [] : await this.rules.forUser(viewer.id);
    const facts = {
      state: 'ACTIVE' as const,
      intervenedById: null,
      blocked: contact.blockedAt !== null,
      contactTagIds: contact.tags.map((t) => t.tagId),
      contactAttributes: (contact.attributes ?? {}) as Record<string, unknown>,
    };
    if (!canAccess(viewer, rules, facts)) throw AppError.notFound('Contact or number not found');

    const id = uuidv7();
    const created = await this.prisma.$transaction(async (tx) => {
      const inserted = await tx.$executeRaw`
        INSERT INTO conversations (id, contact_id, number_id, state, last_activity_at, unresolved_requests, created_at, updated_at)
        VALUES (${id}::uuid, ${contact.id}::uuid, ${number.id}::uuid, 'ACTIVE', now(), 0, now(), now())
        ON CONFLICT (contact_id, number_id) DO NOTHING`;
      if (inserted) await this.timeline.backfill(tx, id, contact.id, number.id);
      return inserted > 0;
    });
    const chatId = created ? id : (await this.prisma.conversation.findUniqueOrThrow({ where: key, select: { id: true } })).id;
    if (created) await this.publisher.conversation(chatId);
    return { created, summary: await this.summaryFor(viewer, chatId) };
  }

  async list(viewer: Viewer, query: ConversationListQuery) {
    const rules = seesAll(viewer) ? [] : await this.rules.forUser(viewer.id);
    const filters: Prisma.Sql[] = [visibleSql(viewer, rules, { conversation: 'c', contact: 'k' })];
    if (query.mine) filters.push(Prisma.sql`c.intervened_by_id = ${viewer.id}::uuid`);
    if (query.numberId) filters.push(Prisma.sql`c.number_id = ${query.numberId}::uuid`);
    if (query.tagId) filters.push(Prisma.sql`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = c.contact_id AND ct.tag_id = ${query.tagId}::uuid)`);
    if (query.attribute) {
      const split = query.attribute.indexOf(':');
      filters.push(Prisma.sql`(k.attributes ->> ${query.attribute.slice(0, split)}) = ${query.attribute.slice(split + 1)}`);
    }
    if (query.campaignId) {
      filters.push(Prisma.sql`EXISTS (SELECT 1 FROM messages msg WHERE msg.campaign_id = ${query.campaignId}::uuid AND msg.contact_id = c.contact_id)`);
    }
    if (query.q) {
      const digits = query.q.replace(/\D/g, '');
      const byName = Prisma.sql`k.name ILIKE ${`%${escapeLike(query.q)}%`}`;
      filters.push(digits.length >= 3 ? Prisma.sql`(${byName} OR k.phone_e164 LIKE ${`%${digits}%`})` : byName);
    }
    const where = Prisma.join(filters, ' AND ');
    const view =
      query.view === 'history'
        ? Prisma.sql`NOT ${LIVE_SQL}`
        : query.state
          ? Prisma.sql`${LIVE_SQL} AND c.state = ${query.state}::"ConversationState"`
          : LIVE_SQL;
    const cursor = decodeCursor(query.cursor);
    const after = cursor ? Prisma.sql`AND (c.last_activity_at, c.id) < (${cursor.at}, ${cursor.id}::uuid)` : Prisma.empty;

    const page = await this.prisma.$queryRaw<Array<{ id: string; last_activity_at: Date; unread: number }>>`
      SELECT c.id, c.last_activity_at,
             (SELECT count(*) FROM (SELECT 1 FROM chat_messages m
                                     WHERE m.conversation_id = c.id AND m.kind = 'INBOUND'
                                       AND m.occurred_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
                                     LIMIT 100) unread_rows)::int AS unread
        FROM conversations c
        LEFT JOIN contacts k ON k.id = c.contact_id
        LEFT JOIN chat_read_markers r ON r.conversation_id = c.id AND r.user_id = ${viewer.id}::uuid
       WHERE ${where} AND ${view} ${after}
       ORDER BY c.last_activity_at DESC, c.id DESC
       LIMIT ${query.limit + 1}`;
    const [counts] = await this.prisma.$queryRaw<Array<{ active: number; requesting: number; intervened: number; history: number }>>`
      SELECT count(*) FILTER (WHERE ${LIVE_SQL} AND c.state = 'ACTIVE')::int AS active,
             count(*) FILTER (WHERE ${LIVE_SQL} AND c.state = 'REQUESTING')::int AS requesting,
             count(*) FILTER (WHERE ${LIVE_SQL} AND c.state = 'INTERVENED')::int AS intervened,
             count(*) FILTER (WHERE NOT ${LIVE_SQL})::int AS history
        FROM conversations c
        LEFT JOIN contacts k ON k.id = c.contact_id
       WHERE ${where}`;

    const hasMore = page.length > query.limit;
    const pageRows = page.slice(0, query.limit);
    const rows = await this.prisma.conversation.findMany({ where: { id: { in: pageRows.map((r) => r.id) } }, include: SUMMARY_INCLUDE });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const now = new Date();
    const items = pageRows.flatMap((p) => {
      const row = byId.get(p.id);
      return row ? [toSummaryDto(row, p.unread, now)] : [];
    });
    const last = pageRows.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor(last.last_activity_at, last.id) : null,
      counts: { ACTIVE: counts?.active ?? 0, REQUESTING: counts?.requesting ?? 0, INTERVENED: counts?.intervened ?? 0, HISTORY: counts?.history ?? 0 },
    };
  }

  /** Numbers a member can start a chat from (agents cannot list numbers in settings). */
  async numbers() {
    return this.prisma.whatsAppNumber.findMany({
      where: { connectionStatus: { not: 'DISCONNECTED' } },
      select: { id: true, label: true, displayPhoneNumber: true },
      orderBy: { label: 'asc' },
    });
  }

  /** Loads a chat the viewer may see, or answers 404 (contract header). */
  async loadVisible(viewer: Viewer, id: string): Promise<ConversationRow> {
    const row = await this.prisma.conversation.findUnique({ where: { id }, include: SUMMARY_INCLUDE });
    if (!row) throw AppError.notFound('Chat not found');
    const rules = seesAll(viewer) ? [] : await this.rules.forUser(viewer.id);
    if (!canAccess(viewer, rules, factsOf(row))) throw AppError.notFound('Chat not found');
    return row;
  }

  /** The chat as one list row, with the viewer's unread count. */
  async summaryFor(viewer: Viewer, id: string): Promise<ConversationSummaryDto> {
    const row = await this.prisma.conversation.findUniqueOrThrow({ where: { id }, include: SUMMARY_INCLUDE });
    return toSummaryDto(row, await this.unreadFor(viewer.id, row.id));
  }

  async detail(viewer: Viewer, id: string) {
    const row = await this.loadVisible(viewer, id);
    const [unread, templateMessageCount, sessionMessageCount, contact, campaigns] = await Promise.all([
      this.unreadFor(viewer.id, id),
      this.prisma.chatMessage.count({ where: { conversationId: id, kind: 'MESSAGE_REF' } }),
      this.prisma.chatMessage.count({ where: { conversationId: id, kind: 'SESSION_OUT' } }),
      row.contactId
        ? this.prisma.contact.findUnique({
            where: { id: row.contactId },
            select: {
              id: true,
              name: true,
              phoneE164: true,
              leadSource: true,
              consentStatus: true,
              consentSource: true,
              consentAt: true,
              attributes: true,
              blockedAt: true,
              firstMessageTag: { select: { id: true, name: true } },
              tags: { select: { tag: { select: { id: true, name: true } } } },
            },
          })
        : null,
      row.contactId
        ? this.prisma.message.findMany({
            where: { contactId: row.contactId, campaignId: { not: null } },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: { campaignId: true, status: true, sentAt: true, campaign: { select: { name: true } } },
          })
        : [],
    ]);
    const live = isLive(row.lastCustomerMessageAt);
    const numberUsable = row.number.connectionStatus === 'CONNECTED' && row.number.sendingEnabled;
    const mayAct = can(viewer.role, 'inbox.reply') && (row.state !== 'INTERVENED' || row.intervenedById === viewer.id);
    return {
      ...toSummaryDto(row, unread),
      profile: {
        contactId: contact?.id ?? null,
        name: contact?.name ?? null,
        phone: contact?.phoneE164 ?? null,
        leadSource: contact?.leadSource ?? null,
        firstMessageTag: contact?.firstMessageTag ?? null,
        consentStatus: contact?.consentStatus ?? 'UNKNOWN',
        consentSource: contact?.consentSource ?? null,
        consentAt: contact?.consentAt?.toISOString() ?? null,
        attributes: (contact?.attributes ?? {}) as Record<string, unknown>,
        tags: (contact?.tags.map((t) => t.tag) ?? []).sort((a, b) => a.name.localeCompare(b.name)),
        blocked: contact?.blockedAt != null,
      },
      lastActiveAt: row.lastCustomerMessageAt?.toISOString() ?? null,
      templateMessageCount,
      sessionMessageCount,
      unresolvedRequests: row.unresolvedRequests,
      recentCampaigns: campaigns.map((m) => ({
        campaignId: m.campaignId!,
        name: m.campaign?.name ?? '',
        sentAt: m.sentAt?.toISOString() ?? null,
        status: m.status,
      })),
      canReply: live && numberUsable && mayAct,
    };
  }

  /** Take chat (FR-019): one conditional UPDATE, so exactly one of several callers wins (R6). */
  async intervene(viewer: Viewer, id: string): Promise<ConversationSummaryDto> {
    const row = await this.loadVisible(viewer, id);
    await this.take(viewer, row);
    return this.summaryFor(viewer, id);
  }

  /** Takes the chat for the viewer; a no-op for the current owner, 409 ALREADY_TAKEN otherwise. */
  async take(viewer: Viewer, row: ConversationRow): Promise<void> {
    const now = new Date();
    const taken = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.conversation.updateMany({
        where: { id: row.id, state: { in: ['ACTIVE', 'REQUESTING'] } },
        data: { state: 'INTERVENED', intervenedById: viewer.id, intervenedAt: now },
      });
      if (!updated.count) return false;
      await tx.conversationEvent.create({ data: { conversationId: row.id, type: 'INTERVENED', actorType: 'MEMBER', actorUserId: viewer.id, occurredAt: now } });
      const openingId = await latestOpeningId(tx, row.id);
      if (openingId) {
        await tx.conversationOpening.updateMany({ where: { id: openingId, intervenedAt: null }, data: { intervenedAt: now, intervenedById: viewer.id } });
      }
      return true;
    });
    if (!taken) {
      const current = await this.prisma.conversation.findUnique({ where: { id: row.id }, select: { intervenedById: true, intervenedBy: { select: { name: true } } } });
      if (current?.intervenedById === viewer.id) return;
      const owner = current?.intervenedBy?.name ?? 'Another member';
      throw new AppError(HttpStatus.CONFLICT, 'ALREADY_TAKEN', `${owner} has already taken this chat`, [{ field: 'intervenedBy', issue: owner }]);
    }
    await this.publisher.conversation(row.id, previous(row));
  }

  /** Close chat (FR-023): the owner, an admin or a manager returns it to Active. */
  async resolve(viewer: Viewer, id: string): Promise<ConversationSummaryDto> {
    const row = await this.loadVisible(viewer, id);
    const transition = resolveTransition({ state: row.state, intervenedById: row.intervenedById }, { id: viewer.id, canMonitor: seesAll(viewer) });
    if (!transition.ok) {
      throw AppError.conflict(
        transition.error === 'NOT_INTERVENED' ? 'Nobody has taken this chat' : 'Only the member who took this chat, an admin or a manager can close it',
        transition.error,
      );
    }
    const now = new Date();
    const resolved = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.conversation.updateMany({
        where: { id, state: 'INTERVENED', intervenedById: row.intervenedById },
        data: { state: 'ACTIVE', intervenedById: null, intervenedAt: null, unresolvedRequests: 0 },
      });
      if (!updated.count) return false;
      await tx.conversationEvent.create({ data: { conversationId: id, type: 'RESOLVED', actorType: 'MEMBER', actorUserId: viewer.id, occurredAt: now } });
      const openingId = await latestOpeningId(tx, id);
      if (openingId) await tx.conversationOpening.updateMany({ where: { id: openingId, resolvedAt: null }, data: { resolvedAt: now, resolvedById: viewer.id } });
      return true;
    });
    if (!resolved) throw AppError.conflict('The chat changed meanwhile; refresh and try again', 'CONFLICT');
    await this.publisher.conversation(id, previous(row));
    return this.summaryFor(viewer, id);
  }

  /** Marks the chat read for the viewer and sends WhatsApp a read receipt, best effort (R8, R11). */
  async markRead(viewer: Viewer, id: string): Promise<void> {
    const row = await this.loadVisible(viewer, id);
    const now = new Date();
    // Customer timestamps can run slightly ahead of our clock; read up to the newest message.
    const lastReadAt = row.lastInboundAt && row.lastInboundAt > now ? row.lastInboundAt : now;
    await this.prisma.chatReadMarker.upsert({
      where: { userId_conversationId: { userId: viewer.id, conversationId: id } },
      create: { userId: viewer.id, conversationId: id, lastReadAt },
      update: { lastReadAt },
    });
    await this.redis.del(unreadKey(viewer.id)).catch(() => undefined);
    if (!row.lastInboundAt || !can(viewer.role, 'inbox.reply')) return;
    try {
      if (await this.redis.set(`wbm:inbox:read-receipt:${id}`, '1', 'EX', READ_RECEIPT_GAP_SECONDS, 'NX')) {
        const job = readReceiptJob(id);
        await this.queues.get(INBOX_QUEUE).add(job.name, job.data, job.opts);
      }
    } catch (error) {
      this.logger.warn({ err: (error as Error).message, conversationId: id }, 'Could not queue a read receipt');
    }
  }

  /** Visible chats with customer messages the viewer has not read (navigation badge, R8). */
  async unreadTotal(viewer: Viewer): Promise<{ total: number }> {
    const cached = await this.redis.get(unreadKey(viewer.id)).catch(() => null);
    if (cached !== null) return { total: Number(cached) };
    const rules = seesAll(viewer) ? [] : await this.rules.forUser(viewer.id);
    const [row] = await this.prisma.$queryRaw<Array<{ total: number }>>`
      SELECT count(*)::int AS total
        FROM conversations c
        LEFT JOIN contacts k ON k.id = c.contact_id
        LEFT JOIN chat_read_markers r ON r.conversation_id = c.id AND r.user_id = ${viewer.id}::uuid
       WHERE c.last_inbound_at IS NOT NULL
         AND c.last_inbound_at > COALESCE(r.last_read_at, '-infinity'::timestamptz)
         AND k.blocked_at IS NULL
         AND ${visibleSql(viewer, rules, { conversation: 'c', contact: 'k' })}`;
    const total = row?.total ?? 0;
    await this.redis.set(unreadKey(viewer.id), String(total), 'EX', UNREAD_CACHE_SECONDS).catch(() => undefined);
    return { total };
  }

  private async unreadFor(userId: string, conversationId: string): Promise<number> {
    const [row] = await this.prisma.$queryRaw<Array<{ unread: number }>>`
      SELECT count(*)::int AS unread FROM (
        SELECT 1 FROM chat_messages m
         WHERE m.conversation_id = ${conversationId}::uuid AND m.kind = 'INBOUND'
           AND m.occurred_at > COALESCE((SELECT last_read_at FROM chat_read_markers
                                          WHERE user_id = ${userId}::uuid AND conversation_id = ${conversationId}::uuid), '-infinity'::timestamptz)
         LIMIT 100) unread_rows`;
    return row?.unread ?? 0;
  }
}

/** Facts before a change, for the "left your view" event (realtime-events.md rule 1). */
export function previous(row: ConversationRow): PreviousFacts {
  return { state: row.state, intervenedById: row.intervenedById, blocked: row.contact?.blockedAt != null };
}

async function latestOpeningId(tx: Prisma.TransactionClient, conversationId: string): Promise<string | null> {
  const opening = await tx.conversationOpening.findFirst({ where: { conversationId }, orderBy: { openedAt: 'desc' }, select: { id: true } });
  return opening?.id ?? null;
}
