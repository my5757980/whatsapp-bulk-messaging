import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { JourneyActor, JourneyEventType, Prisma } from '../../../generated/prisma/client.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';

/** The flow name stored on flow journey entries (feature 003). */
/** The agent name AI agent entries carry in their data (feature 004). */
function agentNameOf(data: unknown): string | null {
  const name = data && typeof data === 'object' ? (data as { agentName?: unknown }).agentName : null;
  return typeof name === 'string' ? name : null;
}

function flowNameOf(data: unknown): string | null {
  const name = data && typeof data === 'object' ? (data as { flowName?: unknown }).flowName : null;
  return typeof name === 'string' ? name : null;
}

export interface JourneyEntry {
  type: string;
  at: string;
  actor: { type: 'MEMBER' | 'CUSTOMER' | 'SYSTEM' | 'CAMPAIGN' | 'FLOW' | 'AI_AGENT'; name: string | null };
  data: Record<string, unknown>;
}

/** How many entries the journey panel shows. */
const JOURNEY_LIMIT = 100;

/**
 * The customer journey beside a chat (T070, FR-033): journey events merged with the campaign and
 * API templates the contact received on that number, newest first.
 */
@Injectable()
export class JourneyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: InboxPublisher,
  ) {}

  async entries(conversationId: string): Promise<JourneyEntry[]> {
    const [events, sends, clicks] = await Promise.all([
      this.prisma.conversationEvent.findMany({
        where: { conversationId },
        include: { actorUser: { select: { name: true } } },
        orderBy: { occurredAt: 'desc' },
        take: JOURNEY_LIMIT,
      }),
      this.prisma.chatMessage.findMany({
        where: { conversationId, kind: 'MESSAGE_REF', origin: { in: ['CAMPAIGN', 'API'] } },
        include: { message: { select: { status: true, template: { select: { name: true } }, campaign: { select: { id: true, name: true } } } } },
        orderBy: { occurredAt: 'desc' },
        take: JOURNEY_LIMIT,
      }),
      this.linkClicks(conversationId),
    ]);
    const merged: Array<JourneyEntry & { sortAt: number }> = [
      ...events.map((e) => ({
        type: e.type,
        at: e.occurredAt.toISOString(),
        actor: {
          type: e.actorType,
          // Flow entries name the flow (feature 003), AI agent entries the agent (feature 004); members name the member.
          name:
            e.actorType === 'MEMBER' ? (e.actorUser?.name ?? null) : e.actorType === 'FLOW' ? flowNameOf(e.data) : e.actorType === 'AI_AGENT' ? agentNameOf(e.data) : null,
        },
        data: (e.data ?? {}) as Record<string, unknown>,
        sortAt: e.occurredAt.getTime(),
      })),
      ...sends.map((s) => ({
        type: s.origin === 'API' ? 'API_SENT' : 'CAMPAIGN_SENT',
        at: s.occurredAt.toISOString(),
        actor: s.origin === 'API' ? { type: 'SYSTEM' as const, name: 'API' } : { type: 'CAMPAIGN' as const, name: s.message?.campaign?.name ?? null },
        data: { campaignId: s.message?.campaign?.id ?? null, template: s.message?.template.name ?? null, status: s.message?.status ?? null },
        sortAt: s.occurredAt.getTime(),
      })),
      // Clicks on tracked links of messages sent on this chat's number (feature 005, FR-009).
      ...clicks.map((c) => ({
        type: 'LINK_CLICKED',
        at: c.clickedAt.toISOString(),
        actor: { type: 'CUSTOMER' as const, name: null },
        data: { campaignId: c.campaignId, campaignName: c.campaignName, dripId: c.dripId, dripName: c.dripName, destination: c.destination },
        sortAt: c.clickedAt.getTime(),
      })),
    ];
    return merged
      .sort((a, b) => b.sortAt - a.sortAt)
      .slice(0, JOURNEY_LIMIT)
      .map(({ sortAt: _sortAt, ...entry }) => entry);
  }

  /** The contact's clicks on links sent from this chat's number, newest first. */
  private linkClicks(conversationId: string) {
    return this.prisma.$queryRaw<
      Array<{ clickedAt: Date; campaignId: string | null; campaignName: string | null; dripId: string | null; dripName: string | null; destination: string }>
    >`
      SELECT lc.clicked_at AS "clickedAt", lc.campaign_id AS "campaignId", cp.name AS "campaignName",
             d.id AS "dripId", d.name::text AS "dripName", t.destination
        FROM conversations cv
        JOIN link_clicks lc ON lc.contact_id = cv.contact_id
        JOIN tracked_links tl ON tl.id = lc.tracked_link_id
        JOIN messages m ON m.id = tl.message_id AND m.number_id = cv.number_id
        JOIN tracked_link_targets t ON t.id = lc.target_id
        LEFT JOIN campaigns cp ON cp.id = lc.campaign_id
        LEFT JOIN drip_steps s ON s.id = lc.drip_step_id
        LEFT JOIN drips d ON d.id = s.drip_id
       WHERE cv.id = ${conversationId}::uuid
       ORDER BY lc.clicked_at DESC
       LIMIT ${JOURNEY_LIMIT}`;
  }

  /** Adds the same journey event to every chat of a contact (consent, blocking). */
  async recordForContact(
    contactId: string,
    event: { type: JourneyEventType; actorType: JourneyActor; actorUserId?: string | null; data?: Record<string, unknown> },
  ): Promise<string[]> {
    const chats = await this.prisma.conversation.findMany({ where: { contactId }, select: { id: true } });
    if (!chats.length) return [];
    const occurredAt = new Date();
    await this.prisma.conversationEvent.createMany({
      data: chats.map((c) => ({
        conversationId: c.id,
        type: event.type,
        actorType: event.actorType,
        actorUserId: event.actorUserId ?? null,
        data: (event.data ?? {}) as Prisma.InputJsonValue,
        occurredAt,
      })),
    });
    return chats.map((c) => c.id);
  }

  /** Called when consent changes, e.g. a STOP keyword (001 inbound handler). */
  async consentChanged(contactId: string, status: string, source: string): Promise<void> {
    const ids = await this.recordForContact(contactId, {
      type: 'CONSENT_CHANGED',
      actorType: source === 'KEYWORD' ? 'CUSTOMER' : 'SYSTEM',
      data: { status, source },
    });
    if (ids.length) await this.publisher.contactUpdated(contactId);
  }
}
