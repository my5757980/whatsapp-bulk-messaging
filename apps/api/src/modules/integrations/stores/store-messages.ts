import { Injectable, Logger } from '@nestjs/common';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma, StoreConnection, StoreMessageKind } from '../../../generated/prisma/client.js';
import { sendJobId } from '../../sending/dispatch-planner.js';
import { MAX_SEND_ATTEMPTS } from '../../sending/send-outcome.js';
import { PlatformEvents } from '../webhooks/platform-events.js';

// Messages of store orders (feature 006 US4 and US5, FR-030): each kind is claimed once per order in
// store_order_messages (unique order and kind), so a notification goes out at most once however often
// the store repeats an event. A claimed send writes the message with origin STORE in the same
// transaction and then queues it on the number's send queue, as 001 does.

export interface StoreSend {
  store: Pick<StoreConnection, 'id' | 'name' | 'platform' | 'numberId'>;
  order: { id: string; orderNumber: string };
  kind: StoreMessageKind;
  contactId: string;
  phone: { e164: string; country: string };
  templateId: string;
  params: Record<string, string>;
}

@Injectable()
export class StoreMessages {
  private readonly logger = new Logger(StoreMessages.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly platformEvents: PlatformEvents,
    private readonly metrics: MetricsService,
  ) {}

  /** True when this kind was already sent or skipped for the order. */
  async claimed(orderId: string, kind: StoreMessageKind): Promise<boolean> {
    return (await this.prisma.storeOrderMessage.count({ where: { orderId, kind } })) > 0;
  }

  /** Records a skip once; false when the kind was already handled. */
  async skip(orderId: string, kind: StoreMessageKind, reason: string): Promise<boolean> {
    try {
      await this.prisma.storeOrderMessage.create({ data: { orderId, kind, outcome: 'SKIPPED', skipReason: reason } });
      this.metrics.storeMessagesTotal.inc({ kind, result: 'skipped' });
      return true;
    } catch (error) {
      if (isUniqueViolation(error)) return false;
      throw error;
    }
  }

  /** Claims the kind and writes the message; null when it was already handled. */
  async send(input: StoreSend): Promise<string | null> {
    const now = new Date();
    let messageId: string;
    try {
      messageId = await this.prisma.$transaction(async (tx) => {
        const claim = await tx.storeOrderMessage.create({ data: { orderId: input.order.id, kind: input.kind, outcome: 'QUEUED' } });
        const message = await tx.message.create({
          data: {
            origin: 'STORE',
            storeOrderId: input.order.id,
            contactId: input.contactId,
            phoneE164: input.phone.e164,
            recipientCountry: input.phone.country,
            numberId: input.store.numberId,
            templateId: input.templateId,
            resolvedParams: input.params as Prisma.InputJsonValue,
            status: 'QUEUED',
            queuedAt: now,
          },
        });
        await tx.messageEvent.create({ data: { messageId: message.id, type: 'QUEUED', occurredAt: now, dedupeKey: `${message.id}:queued` } });
        await tx.storeOrderMessage.update({ where: { id: claim.id }, data: { messageId: message.id } });
        // Outbound webhooks (feature 006, FR-002).
        await this.platformEvents.storeNotificationSent(tx, {
          store: { id: input.store.id, name: input.store.name, platform: input.store.platform },
          order: { id: input.order.id, number: input.order.orderNumber },
          kind: input.kind,
          contactId: input.contactId,
          messageId: message.id,
        });
        return message.id;
      });
    } catch (error) {
      if (isUniqueViolation(error)) return null;
      throw error;
    }
    try {
      await this.queues.sendQueue(input.store.numberId).add(
        'send',
        { messageId },
        { jobId: sendJobId(messageId), attempts: MAX_SEND_ATTEMPTS, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
      );
    } catch (error) {
      this.logger.error({ err: error, messageId }, 'Could not queue a store message');
      await this.prisma.message.updateMany({ where: { id: messageId, status: 'QUEUED' }, data: { status: 'FAILED', failureReason: 'queue_unavailable', failedAt: new Date() } });
    }
    this.metrics.storeMessagesTotal.inc({ kind: input.kind, result: 'queued' });
    return messageId;
  }
}
