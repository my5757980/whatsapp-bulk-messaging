import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { JourneyActor, JourneyEventType, Prisma } from '../../../generated/prisma/client.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';

/** The flow name stored on flow journey entries (feature 003). */
function flowNameOf(data: unknown): string | null {
  const name = data && typeof data === 'object' ? (data as { flowName?: unknown }).flowName : null;
  return typeof name === 'string' ? name : null;
}

export interface JourneyEntry {
  type: string;
  at: string;
  actor: { type: 'MEMBER' | 'CUSTOMER' | 'SYSTEM' | 'CAMPAIGN' | 'FLOW'; name: string | null };
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
    const [events, sends] = await Promise.all([
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
    ]);
    const merged: Array<JourneyEntry & { sortAt: number }> = [
      ...events.map((e) => ({
        type: e.type,
        at: e.occurredAt.toISOString(),
        actor: {
          type: e.actorType,
          // Flow entries name the flow (feature 003); members name the member.
          name: e.actorType === 'MEMBER' ? (e.actorUser?.name ?? null) : e.actorType === 'FLOW' ? flowNameOf(e.data) : null,
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
    ];
    return merged
      .sort((a, b) => b.sortAt - a.sortAt)
      .slice(0, JOURNEY_LIMIT)
      .map(({ sortAt: _sortAt, ...entry }) => entry);
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
