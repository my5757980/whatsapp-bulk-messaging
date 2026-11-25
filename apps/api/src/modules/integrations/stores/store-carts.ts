import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  CART_EXPIRY_MS,
  cartAfterEvent,
  cartDueAt,
  cartExpired,
  cartFieldValues,
  mapShopifyCheckout,
  mapWooOrder,
  resolveOrderValues,
  wooCartFacts,
  type OrderVariableSource,
  type StoreCartFacts,
} from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma, StoreConnection } from '../../../generated/prisma/client.js';
import { TrackedLinkCodes } from '../../growth/links/link-codes.js';
import { sendJobId } from '../../sending/dispatch-planner.js';
import { MAX_SEND_ATTEMPTS } from '../../sending/send-outcome.js';
import { PlatformEvents } from '../webhooks/platform-events.js';
import { ShopifyClient } from './shopify/shopify.client.js';
import { StoreHttp, type WooCredentials } from './store-http.js';
import { WooClient } from './woocommerce/woo.client.js';

// Abandoned carts (feature 006 US6, FR-039 - FR-044, research R11): checkouts (Shopify) and unpaid
// orders (WooCommerce) become carts; up to three marketing reminders go out at their times, each
// once, with the cart link as a 005 tracked link; an order after a reminder recovers the cart, and
// opt-outs, blocks and replies stop it.

type Db = Prisma.TransactionClient | PrismaService;
const OPEN = ['OPEN', 'REMINDING'] as const;

/**
 * Stops the contact's waiting carts inside the caller's transaction: opt-outs (consent), blocks (live
 * chat), replies on the store's number (inbound) and deletion (FR-042, FR-060).
 */
export async function stopContactCarts(db: Db, contactId: string, reason: 'opted_out' | 'blocked' | 'replied' | 'deleted', numberId?: string): Promise<void> {
  await db.storeCart.updateMany({
    where: { contactId, status: { in: ['OPEN', 'REMINDING'] }, ...(numberId ? { store: { numberId } } : {}) },
    data: { status: 'STOPPED', stopReason: reason, nextAt: null },
  });
}

export interface CartStep {
  templateId: string;
  variableMapping: Record<string, OrderVariableSource>;
  waitMinutes: number;
}

@Injectable()
export class StoreCarts {
  private readonly logger = new Logger(StoreCarts.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly codes: TrackedLinkCodes,
    private readonly http: StoreHttp,
    private readonly shopify: ShopifyClient,
    private readonly woo: WooClient,
    private readonly platformEvents: PlatformEvents,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async steps(storeId: string): Promise<CartStep[] | null> {
    const row = await this.prisma.storeAutomation.findUnique({ where: { storeId_kind: { storeId, kind: 'CART_REMINDER' } } });
    const steps = row?.enabled ? (row.steps as unknown as CartStep[]) : [];
    return steps.length ? steps : null;
  }

  /** A checkout or an unpaid order: the cart, with its first reminder planned when reminders are on. */
  async track(store: Pick<StoreConnection, 'id'>, facts: StoreCartFacts, contact: { id: string } | null, phone: string | null): Promise<void> {
    if (!facts.externalId) return;
    const existing = await this.prisma.storeCart.findUnique({ where: { storeId_externalId: { storeId: store.id, externalId: facts.externalId.slice(0, 64) } } });
    const details = {
      value: facts.value,
      currency: facts.currency.slice(0, 3),
      itemsSummary: facts.items?.slice(0, 300) ?? null,
      cartUrl: facts.cartUrl?.slice(0, 2000) ?? null,
      storeUpdatedAt: new Date(facts.updatedAt),
      ...(contact ? { contactId: contact.id, phoneE164: phone } : {}),
    };
    if (existing) {
      if (existing.storeUpdatedAt.getTime() <= new Date(facts.updatedAt).getTime()) await this.prisma.storeCart.update({ where: { id: existing.id }, data: details });
      return;
    }
    if (facts.completed) return;
    const steps = await this.steps(store.id);
    const startedAt = new Date(facts.startedAt);
    const skipped = !contact || !phone;
    try {
      await this.prisma.storeCart.create({
        data: {
          storeId: store.id,
          externalId: facts.externalId.slice(0, 64),
          startedAt,
          ...details,
          status: skipped ? 'SKIPPED' : 'OPEN',
          stopReason: skipped ? 'no_phone' : null,
          nextStep: 1,
          nextAt: !skipped && steps ? cartDueAt(startedAt, 1, steps) : null,
        },
      });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }

  /** An order: the matching cart is recovered after a reminder, or closed without counting (FR-043). */
  async onOrder(store: Pick<StoreConnection, 'id' | 'name' | 'platform'>, order: { id: string; orderNumber: string; externalId: string; contactId: string | null; total: string; currency: string; placedAt: Date }, checkoutId: string | null): Promise<void> {
    const candidates: Prisma.StoreCartWhereInput[] = [{ externalId: order.externalId }];
    if (checkoutId) candidates.push({ externalId: checkoutId });
    if (order.contactId) candidates.push({ contactId: order.contactId, startedAt: { gte: new Date(order.placedAt.getTime() - CART_EXPIRY_MS) } });
    const cart = await this.prisma.storeCart.findFirst({ where: { storeId: store.id, status: { in: [...OPEN] }, OR: candidates }, orderBy: { startedAt: 'desc' } });
    if (!cart) return;
    const outcome = cartAfterEvent(cart, { kind: 'ORDERED', at: order.placedAt });
    const recovered = outcome.status === 'RECOVERED';
    const { count } = await this.prisma.storeCart.updateMany({
      where: { id: cart.id, status: { in: [...OPEN] } },
      data: {
        status: outcome.status,
        stopReason: recovered ? null : outcome.reason,
        nextAt: null,
        ...(recovered ? { recoveredOrderId: order.id, recoveredValue: order.total, recoveredAt: new Date() } : {}),
      },
    });
    if (count && recovered) {
      // Outbound webhooks (feature 006, FR-002).
      await this.platformEvents.cartRecovered(this.prisma, {
        store: { id: store.id, name: store.name, platform: store.platform },
        cart: { id: cart.id },
        order: { id: order.id, number: order.orderNumber },
        contactId: cart.contactId,
        value: order.total,
        currency: order.currency,
      });
    }
  }

  /** Reminders that are due (the store tick). */
  async remindDue(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM store_carts
       WHERE status IN ('OPEN', 'REMINDING') AND next_at IS NOT NULL AND next_at <= ${now}
       ORDER BY next_at
       LIMIT 200
       FOR UPDATE SKIP LOCKED`;
    for (const { id } of due) {
      await this.remind(id, now).catch((error: unknown) => this.logger.warn({ err: error, cartId: id }, 'Cart reminder failed'));
    }
    return due.length;
  }

  private async finish(cartId: string, status: 'STOPPED' | 'SKIPPED' | 'EXPIRED', reason: string | null): Promise<void> {
    await this.prisma.storeCart.updateMany({ where: { id: cartId, status: { in: [...OPEN] } }, data: { status, stopReason: reason, nextAt: null } });
  }

  private async remind(cartId: string, now: Date): Promise<void> {
    const cart = await this.prisma.storeCart.findUnique({ where: { id: cartId }, include: { store: true, contact: { select: { id: true, name: true, consentStatus: true, blockedAt: true } } } });
    if (!cart || !(OPEN as readonly string[]).includes(cart.status) || !cart.nextAt || cart.nextAt > now) return;
    if (cart.store.status === 'DISCONNECTED') return this.finish(cart.id, 'STOPPED', 'store_disconnected');
    const steps = await this.steps(cart.storeId);
    if (!steps) {
      await this.prisma.storeCart.update({ where: { id: cart.id }, data: { nextAt: null } });
      return;
    }
    if (cartExpired(cart.startedAt, now) || cart.nextStep > steps.length) return this.finish(cart.id, 'EXPIRED', null);

    // The cart is read again: it may have become an order, and webhook payloads can lack details.
    const fresh = await this.refetch(cart).catch((error: unknown) => {
      this.logger.warn({ err: error, cartId: cart.id }, 'Could not read the cart again; using the saved details');
      return null;
    });
    if (fresh?.completed) return this.finish(cart.id, 'STOPPED', 'ordered');
    const contact = cart.contact;
    if (!contact || !cart.phoneE164) return this.finish(cart.id, 'SKIPPED', 'no_phone');
    if (contact.blockedAt) return this.finish(cart.id, 'STOPPED', 'blocked');
    if (contact.consentStatus === 'OPTED_OUT') return this.finish(cart.id, 'STOPPED', 'opted_out');
    // Cart reminders are marketing: only to contacts who opted in (FR-040).
    if (contact.consentStatus !== 'OPTED_IN') return this.finish(cart.id, 'SKIPPED', 'no_consent');

    const step = steps[cart.nextStep - 1]!;
    const nextAt = cartDueAt(cart.startedAt, cart.nextStep + 1, steps) ?? new Date(cart.startedAt.getTime() + CART_EXPIRY_MS);
    const template = await this.prisma.template.findUnique({ where: { id: step.templateId }, select: { status: true, variables: true, wabaId: true } });
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: cart.store.numberId }, select: { connectionStatus: true, sendingEnabled: true, wabaId: true } });
    const values = cartFieldValues(
      fresh ?? { value: cart.value.toFixed(2), currency: cart.currency, customerName: null, firstName: contact.name, items: cart.itemsSummary, cartUrl: cart.cartUrl },
      cart.store.name,
    );
    const variables = ((Array.isArray(template?.variables) ? template.variables : []) as Array<{ key: string }>).map((v) => v.key);
    const resolved = template ? resolveOrderValues(variables, step.variableMapping, values, { name: contact.name, phone: cart.phoneE164 }) : null;
    const usable = template && template.status === 'APPROVED' && number && number.connectionStatus === 'CONNECTED' && number.sendingEnabled && number.wabaId === template.wabaId;
    if (!usable || !resolved?.ok) {
      // This reminder is skipped; the next one still comes.
      await this.prisma.$transaction(async (tx) => {
        await tx.storeCartReminder.create({ data: { cartId: cart.id, step: cart.nextStep, outcome: 'SKIPPED', skipReason: usable ? 'missing_value' : 'template_unavailable' } });
        await tx.storeCart.update({ where: { id: cart.id }, data: { nextStep: cart.nextStep + 1, nextAt } });
      }).catch((error: unknown) => {
        if (!isUniqueViolation(error)) throw error;
      });
      return;
    }

    // The cart link goes through a 005 tracked link, so clicks are counted.
    const linkKey = Object.entries(step.variableMapping).find(([, s]) => s.source === 'order' && s.key === 'cart_url')?.[0];
    const destination = fresh?.cartUrl ?? cart.cartUrl;
    const messageId = uuidv7();
    let target: { id: string; variableKey: string } | null = null;
    const params = { ...resolved.params };
    const sentAt = new Date();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.storeCartReminder.create({ data: { cartId: cart.id, step: cart.nextStep, outcome: 'QUEUED', messageId: null } });
        let plan: ReturnType<TrackedLinkCodes['plan']> | null = null;
        if (linkKey && destination && this.config.PUBLIC_LINK_BASE_URL) {
          target = await tx.trackedLinkTarget.create({ data: { variableKey: linkKey, destination }, select: { id: true, variableKey: true } });
          plan = this.codes.plan([{ id: messageId, contactId: contact.id }], [target]);
          Object.assign(params, plan.params.get(messageId) ?? {});
        }
        await tx.message.create({
          data: {
            id: messageId,
            origin: 'STORE',
            storeCartId: cart.id,
            contactId: contact.id,
            phoneE164: cart.phoneE164!,
            recipientCountry: cart.store.defaultCountry,
            numberId: cart.store.numberId,
            templateId: step.templateId,
            resolvedParams: params as Prisma.InputJsonValue,
            status: 'QUEUED',
            queuedAt: sentAt,
          },
        });
        await tx.messageEvent.create({ data: { messageId, type: 'QUEUED', occurredAt: sentAt, dedupeKey: `${messageId}:queued` } });
        if (plan && target) await this.codes.save(tx, plan.links, [target]);
        await tx.storeCartReminder.update({ where: { cartId_step: { cartId: cart.id, step: cart.nextStep } }, data: { messageId } });
        await tx.storeCart.update({ where: { id: cart.id }, data: { status: 'REMINDING', lastReminderAt: sentAt, nextStep: cart.nextStep + 1, nextAt } });
        await this.platformEvents.storeNotificationSent(tx, {
          store: { id: cart.store.id, name: cart.store.name, platform: cart.store.platform },
          order: { id: cart.id, number: '' },
          kind: 'CART_REMINDER',
          contactId: contact.id,
          messageId,
        });
      });
    } catch (error) {
      if (isUniqueViolation(error)) return;
      throw error;
    }
    await this.queues.sendQueue(cart.store.numberId).add(
      'send',
      { messageId },
      { jobId: sendJobId(messageId), attempts: MAX_SEND_ATTEMPTS, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
    );
  }

  /** The cart's current state from the store (null when it cannot be found). */
  private async refetch(cart: { externalId: string; store: StoreConnection }): Promise<StoreCartFacts | null> {
    if (cart.store.platform === 'SHOPIFY') {
      const token = await this.shopify.tokenFor(cart.store);
      const node = await this.shopify.abandonedCheckout(cart.store, token, cart.externalId);
      return node ? mapShopifyCheckout(node) : null;
    }
    const order = await this.woo.order(cart.store, this.http.open<WooCredentials>(cart.store.credentialsEncrypted), cart.externalId);
    return order ? wooCartFacts(mapWooOrder(order)) : null;
  }
}
