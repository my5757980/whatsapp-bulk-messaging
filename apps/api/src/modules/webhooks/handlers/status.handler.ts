import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { DripLeaving } from '../../growth/drips/drip-leaving.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import { RateCardService } from '../../rate-card/rate-card.controller.js';
import { messageCost } from '../../reports/cost-calculator.js';
import { WebhookRouter, type WebhookChange, type WebhookChangeHandler } from '../webhook-router.js';
import { computeStatusUpdate, parseStatuses, type MetaStatus, type ParsedStatus } from './status-update.js';

const EVENT_TYPE: Record<Exclude<MetaStatus, 'deleted'>, 'SENT' | 'DELIVERED' | 'READ' | 'FAILED'> = {
  sent: 'SENT',
  delivered: 'DELIVERED',
  read: 'READ',
  failed: 'FAILED',
};

/** Status events for a wamid we have not stored yet (the send call may still be returning). */
const BUFFER_TTL_SECONDS = 24 * 3600;
const bufferKey = (wamid: string) => `wbm:status-buffer:${wamid}`;

/**
 * `statuses[]` of `messages` webhooks (T101, contracts/meta-webhooks.md §3): one message_events
 * row per `wamid:status` (re-deliveries are no-ops), the shared precedence rules, timestamps,
 * pricing and failure reasons. Unknown wamids are buffered for 24 h.
 */
@Injectable()
export class StatusHandler implements WebhookChangeHandler, OnModuleInit {
  readonly field = 'messages';

  constructor(
    private readonly router: WebhookRouter,
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly rateCard: RateCardService,
    private readonly inbox: InboxPublisher,
    private readonly drips: DripLeaving,
  ) {}

  onModuleInit(): void {
    this.router.register(this);
  }

  async handle(change: WebhookChange): Promise<void> {
    for (const status of parseStatuses(change.value)) await this.applyOrBuffer(status);
  }

  private async applyOrBuffer(status: ParsedStatus): Promise<void> {
    if (await this.apply(status)) return;
    const { recipientId: _phone, ...withoutPhone } = status;
    const key = bufferKey(status.wamid);
    await this.redis.multi().rpush(key, JSON.stringify(withoutPhone)).expire(key, BUFFER_TTL_SECONDS).exec();
    // The send worker may have stored the wamid between our lookup and the push: check again.
    const stored =
      (await this.prisma.message.findUnique({ where: { waMessageId: status.wamid }, select: { id: true } })) ??
      (await this.prisma.chatMessage.findUnique({ where: { waMessageId: status.wamid }, select: { id: true } }));
    if (stored) await this.applyBuffered(status.wamid);
  }

  /** Applies buffered events once the send worker has stored the wamid. */
  async applyBuffered(wamid: string): Promise<void> {
    const key = bufferKey(wamid);
    const [[, items]] = (await this.redis.multi().lrange(key, 0, -1).del(key).exec()) as [[Error | null, string[]], unknown];
    for (const raw of items ?? []) {
      const parsed = JSON.parse(raw) as Omit<ParsedStatus, 'timestamp'> & { timestamp: string };
      await this.apply({ ...parsed, recipientId: undefined, timestamp: new Date(parsed.timestamp) });
    }
  }

  /** Records the estimated cost once a message is billable (rate card, research R17). */
  private async setCost(messageId: string): Promise<void> {
    const m = await this.prisma.message.findUnique({ where: { id: messageId }, include: { template: { select: { category: true } } } });
    if (!m || m.costUsdMicros !== null) return;
    const cost = messageCost(await this.rateCard.table(), m, m.template.category);
    if (cost !== null) await this.prisma.message.update({ where: { id: messageId }, data: { costUsdMicros: cost } });
  }

  /** Returns false when no message or live chat reply has this wamid yet. */
  async apply(status: ParsedStatus): Promise<boolean> {
    const known = await this.prisma.message.findUnique({ where: { waMessageId: status.wamid }, select: { id: true, origin: true } });
    if (!known) return this.applyToChatReply(status);
    if (status.status === 'deleted') return true; // kept in the raw webhook event only

    let newStatus: string | undefined;
    try {
      await this.prisma.$transaction(async (tx) => {
        // Webhooks are processed in parallel: holding the message row makes concurrent statuses
        // for it apply one after another. NO KEY UPDATE does not conflict with the key-share lock
        // that the event row's foreign key takes, so this cannot deadlock.
        await tx.$queryRaw`SELECT 1 FROM messages WHERE id = ${known.id}::uuid FOR NO KEY UPDATE`;
        await tx.messageEvent.create({
          data: {
            messageId: known.id,
            type: EVENT_TYPE[status.status as Exclude<MetaStatus, 'deleted'>],
            occurredAt: status.timestamp,
            payload: { status: status.status, error: status.error ?? null, pricing: status.pricing ?? null } as Prisma.InputJsonValue,
            dedupeKey: `${status.wamid}:${status.status}`,
          },
        });
        const current = await tx.message.findUniqueOrThrow({
          where: { id: known.id },
          select: { status: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true },
        });
        const update = computeStatusUpdate(current, status);
        if (update) {
          await tx.message.updateMany({ where: { id: known.id, status: current.status }, data: update });
          newStatus = update.status;
        }
      }, { maxWait: 10_000 });
    } catch (error) {
      if (isUniqueViolation(error)) return true; // duplicate delivery of the same event
      throw error;
    }

    if (newStatus === 'DELIVERED' || newStatus === 'READ' || status.pricing?.billable === true) await this.setCost(known.id);
    this.metrics.webhookLag.observe(Math.max(0, (Date.now() - status.timestamp.getTime()) / 1000));
    if (newStatus) {
      const message = await this.prisma.message.findUnique({ where: { id: known.id }, select: { number: { select: { phoneNumberId: true } } } });
      this.metrics.messagesTotal.inc({ status: newStatus, number: message?.number.phoneNumberId ?? 'unknown' });
      // Live ticks for templates sent from a chat; broadcast ticks show when a chat is opened (002 R11).
      if (known.origin === 'INBOX') {
        const ref = await this.prisma.chatMessage.findUnique({ where: { messageId: known.id }, select: { id: true } });
        if (ref) await this.inbox.itemStatus(ref.id);
      }
      // A drip step to a number not on WhatsApp ends that drip for the contact (feature 005, FR-031).
      if (newStatus === 'FAILED' && known.origin === 'DRIP' && status.error?.code === 131026) await this.drips.onInvalidNumber(known.id);
    }
    return true;
  }

  /**
   * Status of a free-form live chat reply (002 T032, contracts/meta-graph-inbox.md §5): the same
   * precedence rules and timestamps as messages. Returns false when no reply has this wamid.
   */
  private async applyToChatReply(status: ParsedStatus): Promise<boolean> {
    const item = await this.prisma.chatMessage.findUnique({ where: { waMessageId: status.wamid }, select: { id: true, kind: true } });
    if (!item || item.kind !== 'SESSION_OUT') return false;
    if (status.status === 'deleted') return true;

    let changed = false;
    await this.prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT 1 FROM chat_messages WHERE id = ${item.id}::uuid FOR NO KEY UPDATE`;
        const current = await tx.chatMessage.findUniqueOrThrow({
          where: { id: item.id },
          select: { status: true, sentAt: true, deliveredAt: true, readAt: true, failedAt: true },
        });
        const update = computeStatusUpdate({ ...current, status: current.status ?? 'SENDING' }, status);
        if (!update) return;
        // Pricing is not tracked for free replies inside the window (service conversations).
        const { billable: _billable, pricingCategory: _category, ...fields } = update;
        changed = (await tx.chatMessage.updateMany({ where: { id: item.id, status: current.status }, data: fields })).count > 0;
      },
      { maxWait: 10_000 },
    );
    this.metrics.webhookLag.observe(Math.max(0, (Date.now() - status.timestamp.getTime()) / 1000));
    if (changed) await this.inbox.itemStatus(item.id);
    return true;
  }
}
