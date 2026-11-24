import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';

// The raw event store of feature 006 US4 (research R9): receivers and the reconciler save each store
// event once (unique by store and delivery id) and queue its processing; the receivers answer the
// store right after, within Shopify's 5-second limit.

export const STORE_EVENT_JOB = 'store-event';
export const STORE_RECONCILE_JOB = 'store-reconcile';

@Injectable()
export class StoreEventsInbox {
  private readonly logger = new Logger(StoreEventsInbox.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
  ) {}

  /** Saves the event; null when the same delivery was saved before. `received` marks a webhook (not a sync). */
  async save(storeId: string, externalId: string, topic: string, payload: unknown, received = true): Promise<bigint | null> {
    const rows = await this.prisma.$queryRaw<Array<{ id: bigint }>>`
      INSERT INTO store_events (store_id, external_id, topic, payload, status, received_at)
      VALUES (${storeId}::uuid, ${externalId.slice(0, 100)}, ${topic.slice(0, 60)}, ${JSON.stringify(payload ?? {})}::jsonb, 'RECEIVED', now())
      ON CONFLICT (store_id, external_id) DO NOTHING
      RETURNING id`;
    const id = rows[0]?.id ?? null;
    if (received) await this.prisma.storeConnection.update({ where: { id: storeId }, data: { lastEventAt: new Date() } });
    if (id !== null) this.enqueue(id);
    return id;
  }

  /** Fire and forget: a lost job is picked up by the next reconciler run's sweep of waiting events. */
  enqueue(eventId: bigint): void {
    this.queues
      .get(QUEUES.STORES)
      .add(STORE_EVENT_JOB, { eventId: eventId.toString() }, { jobId: `store-event-${eventId.toString()}`, attempts: 1, removeOnComplete: true, removeOnFail: 100 })
      .catch((error: unknown) => this.logger.warn({ err: error, eventId: eventId.toString() }, 'Could not queue a store event'));
  }

  /** Asks the reconciler to check one store now (the "Sync now" button). */
  async requestSync(storeId: string): Promise<void> {
    await this.queues.get(QUEUES.STORES).add(STORE_RECONCILE_JOB, { storeId }, { jobId: `store-sync-${storeId}-${Date.now()}`, attempts: 1, removeOnComplete: true, removeOnFail: 20 });
  }
}
