import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { STALE_AFTER_MS } from '@wbm/shared';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry, REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { ShopifyClient } from './shopify/shopify.client.js';
import { STORE_RECONCILE_JOB, StoreEventsInbox } from './store-events-inbox.js';
import { StoreHttp, plainStoreError, type WooCredentials } from './store-http.js';
import { WooClient } from './woocommerce/woo.client.js';

// The store reconciler (feature 006 US4, FR-026, research R7 - R9), every 15 minutes and on "Sync now":
// renews Shopify tokens due within an hour, repairs the store's webhooks (re-creates missing Shopify
// subscriptions, sets WooCommerce webhooks active again), and fetches orders changed since the last
// sync (at most 3 days back) as "sync:" events. Three failed checks in a row move the store to ERROR
// and alert admins; a good check moves it back.

const EVERY_MS = 15 * 60_000;
const failKey = (storeId: string) => `wbm:store-failures:${storeId}`;

@Injectable()
export class StoreReconcilerProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(StoreReconcilerProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly http: StoreHttp,
    private readonly shopify: ShopifyClient,
    private readonly woo: WooClient,
    private readonly inbox: StoreEventsInbox,
    private readonly notifications: NotificationsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.STORES, STORE_RECONCILE_JOB, async (job) => {
      const storeId = (job.data as { storeId?: string } | undefined)?.storeId;
      if (storeId) await this.reconcile(storeId);
      else await this.reconcileAll();
    });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.STORES)
      .upsertJobScheduler('store-reconcile', { every: EVERY_MS }, { name: STORE_RECONCILE_JOB, data: {}, opts: { removeOnComplete: true, removeOnFail: 20 } });
  }

  async reconcileAll(): Promise<void> {
    const stores = await this.prisma.storeConnection.findMany({ where: { status: { not: 'DISCONNECTED' } }, select: { id: true } });
    for (const store of stores) await this.reconcile(store.id);
    // Events whose job was lost (e.g. Redis was down when they arrived) are queued again.
    const waiting = await this.prisma.storeEvent.findMany({ where: { status: 'RECEIVED', receivedAt: { lt: new Date(Date.now() - 5 * 60_000) } }, select: { id: true }, take: 500 });
    for (const event of waiting) this.inbox.enqueue(event.id);
  }

  async reconcile(storeId: string): Promise<void> {
    const store = await this.prisma.storeConnection.findUnique({ where: { id: storeId } });
    if (!store || store.status === 'DISCONNECTED') return;
    const startedAt = new Date();
    const since = new Date(Math.max(store.lastSyncedAt?.getTime() ?? 0, Date.now() - STALE_AFTER_MS));
    try {
      if (store.platform === 'SHOPIFY') {
        const token = await this.shopify.tokenFor(store, 3600_000);
        await this.shopify.ensureSubscriptions(store, token);
        for (const order of await this.shopify.ordersSince(store, token, since)) {
          await this.inbox.save(store.id, `sync:${String(order.admin_graphql_api_id)}:${String(order.updated_at)}`, 'orders/updated', order, false);
        }
      } else {
        const credentials = this.http.open<WooCredentials>(store.credentialsEncrypted);
        const secret = store.webhookSecretEncrypted ? this.http.open<{ secret: string }>(store.webhookSecretEncrypted).secret : '';
        await this.woo.ensureWebhooks(store, credentials, secret);
        for (const order of await this.woo.ordersSince(store, credentials, since)) {
          await this.inbox.save(store.id, `sync:${String(order.id)}:${String(order.date_modified_gmt ?? order.date_modified ?? '')}`, 'order.updated', order, false);
        }
      }
      await this.prisma.storeConnection.update({ where: { id: store.id }, data: { lastSyncedAt: startedAt, lastError: null, ...(store.status === 'ERROR' ? { status: 'CONNECTED' } : {}) } });
      await this.redis.del(failKey(store.id));
    } catch (error) {
      const reason = plainStoreError(error).slice(0, 200);
      const failures = await this.redis.incr(failKey(store.id));
      await this.redis.expire(failKey(store.id), 24 * 3600);
      this.logger.warn({ storeId: store.id, failures, reason }, 'Store check failed');
      const moving = failures >= 3 && store.status === 'CONNECTED';
      await this.prisma.storeConnection.update({ where: { id: store.id }, data: { lastError: reason, ...(moving ? { status: 'ERROR' } : {}) } });
      if (moving) {
        await this.notifications.notifyAdmins({
          type: 'STORE_CONNECTION_ERROR',
          title: 'Store connection needs attention',
          body: `${store.name}: ${reason}. Order messages may be missed until it is fixed.`,
          link: `/integrations/stores/${store.id}`,
        });
      }
    }
  }
}
