import { Injectable, Logger } from '@nestjs/common';
import {
  COD_TAGS,
  codAfterAnswer,
  codAfterStoreChange,
  codPayload,
  codSettings,
  codTimes,
  orderFieldValues,
  parseCodPayload,
  resolveOrderValues,
  type CodAnswer,
  type CodSettingsValues,
  type OrderVariableSource,
  type StoreOrderFacts,
} from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import type { StoreConnection, StoreOrder } from '../../../generated/prisma/client.js';
import { AutoRepliesService } from '../../inbox/automation/auto-replies.service.js';
import { JourneyService } from '../../inbox/journey/journey.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { PlatformEvents } from '../webhooks/platform-events.js';
import { ShopifyClient } from './shopify/shopify.client.js';
import { StoreApiError, StoreHttp, type WooCredentials } from './store-http.js';
import { StoreMessages } from './store-messages.js';
import { WooClient } from './woocommerce/woo.client.js';

// Cash-on-delivery confirmation (feature 006 US5, FR-034 - FR-038, research R10): the question with
// two quick-reply buttons whose payloads carry the order, the first answer winning, the replies, a
// reminder and "no answer", and the store actions (tags and metafield, or a note and meta; cancel
// when the store chose automatic cancel) as retried jobs on the `stores` queue.

export const STORE_ACTION_JOB = 'store-action';
/** Feature 008: an order paid through its pay link is marked paid in the store. */
export const STORE_MARK_PAID_JOB = 'store-mark-paid';

interface Step {
  templateId: string;
  variableMapping: Record<string, OrderVariableSource>;
}

export interface StoreActionData {
  storeId: string;
  orderId: string;
  outcome: 'CONFIRMED' | 'CANCELLED' | 'NO_ANSWER';
  cancel: boolean;
}

type Contact = { id: string; name: string | null; consentStatus: string; blockedAt: Date | null };

const STATUS_WORD: Record<StoreActionData['outcome'], string> = { CONFIRMED: 'confirmed', CANCELLED: 'cancelled', NO_ANSWER: 'no-answer' };

@Injectable()
export class CodService {
  private readonly logger = new Logger(CodService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly messages: StoreMessages,
    private readonly replies: AutoRepliesService,
    private readonly journey: JourneyService,
    private readonly notifications: NotificationsService,
    private readonly platformEvents: PlatformEvents,
    private readonly http: StoreHttp,
    private readonly shopify: ShopifyClient,
    private readonly woo: WooClient,
  ) {}

  /** The store's COD automation when it is on; null otherwise. */
  async automation(storeId: string): Promise<{ step: Step; settings: CodSettingsValues } | null> {
    const row = await this.prisma.storeAutomation.findUnique({ where: { storeId_kind: { storeId, kind: 'COD_CONFIRMATION' } } });
    const step = row?.enabled ? ((row.steps as unknown as Step[])[0] ?? null) : null;
    return step ? { step, settings: codSettings(row?.settings as Partial<CodSettingsValues>) } : null;
  }

  /** A store change before the customer answered: cancelled or paid closes the question (FR-037). */
  async onStoreChange(order: Pick<StoreOrder, 'id' | 'codStatus'>, facts: Pick<StoreOrderFacts, 'cancelled' | 'paid'>): Promise<void> {
    const next = codAfterStoreChange(order.codStatus, facts);
    if (next !== order.codStatus) {
      await this.prisma.storeOrder.updateMany({ where: { id: order.id, codStatus: order.codStatus }, data: { codStatus: next, codNextAt: null } });
    }
  }

  /**
   * Asks a new COD order to confirm, with one payload per button (FR-034). Returns false when it was
   * skipped (the reason is recorded) or already handled.
   */
  async ask(
    store: Pick<StoreConnection, 'id' | 'name' | 'platform' | 'numberId'>,
    order: Pick<StoreOrder, 'id' | 'orderNumber'>,
    facts: StoreOrderFacts,
    cod: { step: Step; settings: CodSettingsValues },
    phone: { e164: string; country: string } | null,
    contact: Contact | null,
    skip: (reason: string) => Promise<boolean>,
  ): Promise<boolean> {
    if (!phone || !contact) return skip('no_phone');
    if (contact.blockedAt) return skip('blocked');
    if (contact.consentStatus === 'OPTED_OUT') return skip('opted_out');
    const template = await this.prisma.template.findUnique({ where: { id: cod.step.templateId }, select: { status: true, category: true, variables: true } });
    if (!template || template.status !== 'APPROVED') return skip('template_unavailable');
    if (template.category === 'MARKETING' && contact.consentStatus !== 'OPTED_IN') return skip('no_opt_in');
    const variables = ((Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>).map((v) => v.key);
    const values = resolveOrderValues(variables, cod.step.variableMapping, orderFieldValues(facts, store.name), { name: contact.name, phone: phone.e164 });
    if (!values.ok) return skip('missing_value');
    const params = { ...values.params, 'BUTTON.0.payload': codPayload(order.id, 'CONFIRMED'), 'BUTTON.1.payload': codPayload(order.id, 'CANCELLED') };
    const messageId = await this.messages.send({ store, order, kind: 'COD_CONFIRMATION', contactId: contact.id, phone, templateId: cod.step.templateId, params });
    if (!messageId) return false;
    const now = new Date();
    await this.prisma.storeOrder.update({ where: { id: order.id }, data: { codStatus: 'ASKED', codAskedAt: now, codNextAt: codTimes(now, cod.settings).reminderAt, codReminded: false } });
    return true;
  }

  /**
   * A button tap in a chat. Returns true when the payload was a COD answer (handled here, so flows and
   * the AI agent do not answer it).
   */
  async handleButton(payload: string | null, inbound: { conversationId: string; contactId: string }): Promise<boolean> {
    const parsed = parseCodPayload(payload);
    if (!parsed) return false;
    const order = await this.prisma.storeOrder.findUnique({ where: { id: parsed.orderId }, include: { store: true } });
    // Only the customer the question went to can answer it.
    if (!order || order.contactId !== inbound.contactId) return true;
    const cod = await this.automation(order.storeId);
    const settings = cod?.settings ?? codSettings(null);
    const transition = codAfterAnswer(order.codStatus, parsed.answer);
    let accepted = false;
    if (transition.accepted) {
      const { count } = await this.prisma.storeOrder.updateMany({
        where: { id: order.id, codStatus: order.codStatus },
        data: { codStatus: transition.status, codAnsweredAt: new Date(), codNextAt: null },
      });
      accepted = count === 1;
    }
    const reply = !accepted ? settings.alreadyAnsweredReply : parsed.answer === 'CONFIRMED' ? settings.confirmedReply : settings.cancelledReply;
    await this.prisma.storeOrderMessage.create({ data: { orderId: order.id, kind: 'COD_REPLY', outcome: 'QUEUED' } });
    await this.replies.sendText(inbound.conversationId, reply).catch((error: unknown) => this.logger.warn({ err: error, orderId: order.id }, 'Could not send the COD reply'));
    if (accepted) await this.answered(order, parsed.answer, settings);
    return true;
  }

  /** Effects of an answer (or of no answer): the store action, the journey, the webhook event and alerts. */
  async answered(order: StoreOrder & { store: StoreConnection }, outcome: CodAnswer | 'NO_ANSWER', settings: CodSettingsValues): Promise<void> {
    const cancel = outcome === 'CANCELLED' && settings.autoCancel;
    await this.enqueueAction({ storeId: order.storeId, orderId: order.id, outcome, cancel });
    if (order.contactId) {
      await this.journey.recordForContact(order.contactId, {
        type: 'COD_ANSWERED',
        actorType: outcome === 'NO_ANSWER' ? 'SYSTEM' : 'CUSTOMER',
        data: { store: order.store.name, orderNumber: order.orderNumber, answer: outcome },
      });
    }
    await this.platformEvents.codAnswered(this.prisma, {
      store: { id: order.store.id, name: order.store.name, platform: order.store.platform },
      order: { id: order.id, number: order.orderNumber },
      contactId: order.contactId,
      answer: outcome,
      cancelledInStore: cancel,
    });
    if (outcome === 'CANCELLED' && !settings.autoCancel) {
      await this.notifications.notifyAdmins({
        type: 'COD_CANCELLED',
        title: 'COD order cancelled by the customer',
        body: `${order.store.name}: the customer cancelled order ${order.orderNumber} on WhatsApp. Cancel it in the store.`,
        link: `/integrations/stores/${order.storeId}`,
      });
    }
  }

  /** Reminders and finals that are due (the store tick, every 30 seconds). */
  async tick(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM store_orders
       WHERE cod_status = 'ASKED' AND cod_next_at IS NOT NULL AND cod_next_at <= ${now}
       ORDER BY cod_next_at
       LIMIT 200
       FOR UPDATE SKIP LOCKED`;
    let handled = 0;
    for (const { id } of due) {
      const order = await this.prisma.storeOrder.findUnique({ where: { id }, include: { store: true } });
      if (!order || order.codStatus !== 'ASKED' || !order.codAskedAt) continue;
      const cod = await this.automation(order.storeId);
      const settings = cod?.settings ?? codSettings(null);
      const { finalAt } = codTimes(order.codAskedAt, settings);
      if (!order.codReminded && now < finalAt && cod) {
        await this.remind(order, cod);
        await this.prisma.storeOrder.updateMany({ where: { id, codStatus: 'ASKED' }, data: { codReminded: true, codNextAt: finalAt } });
      } else if (now >= finalAt) {
        const { count } = await this.prisma.storeOrder.updateMany({ where: { id, codStatus: 'ASKED' }, data: { codStatus: 'NO_ANSWER', codNextAt: null } });
        if (count) await this.answered(order, 'NO_ANSWER', settings);
      } else {
        await this.prisma.storeOrder.updateMany({ where: { id, codStatus: 'ASKED' }, data: { codNextAt: finalAt } });
      }
      handled += 1;
    }
    return handled;
  }

  /** The reminder: the same question again (a template, as the chat may be closed). */
  private async remind(order: StoreOrder & { store: StoreConnection }, cod: { step: Step; settings: CodSettingsValues }): Promise<void> {
    const first = await this.prisma.storeOrderMessage.findFirst({ where: { orderId: order.id, kind: 'COD_CONFIRMATION', outcome: 'QUEUED' }, include: { message: true } });
    const message = first?.message;
    if (!message?.contactId || !message.phoneE164) return;
    await this.messages.send({
      store: order.store,
      order,
      kind: 'COD_REMINDER',
      contactId: message.contactId,
      phone: { e164: message.phoneE164, country: message.recipientCountry ?? order.store.defaultCountry },
      templateId: cod.step.templateId,
      params: message.resolvedParams as Record<string, string>,
    });
  }

  async enqueueAction(data: StoreActionData): Promise<void> {
    await this.queues.get(QUEUES.STORES).add(STORE_ACTION_JOB, data, {
      jobId: `store-action-${data.orderId}-${data.outcome}`,
      attempts: 6,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: true,
      removeOnFail: 200,
    });
  }

  /** Marks the store order (tags and metafield, or a note and meta), and cancels it when chosen; throws to be retried. */
  async runAction(data: StoreActionData): Promise<void> {
    const order = await this.prisma.storeOrder.findUnique({ where: { id: data.orderId }, include: { store: true } });
    if (!order || order.store.status === 'DISCONNECTED') return;
    const word = STATUS_WORD[data.outcome];
    if (order.store.platform === 'SHOPIFY') {
      const token = await this.shopify.tokenFor(order.store);
      await this.shopify.tagOrder(order.store, token, order.externalId, [COD_TAGS[data.outcome]]);
      await this.shopify.setCodStatus(order.store, token, order.externalId, word);
      if (data.cancel) await this.shopify.cancelOrder(order.store, token, order.externalId);
    } else {
      const credentials = this.http.open<WooCredentials>(order.store.credentialsEncrypted);
      await this.woo.addNote(order.store, credentials, order.externalId, `WhatsApp COD confirmation: ${word}.`);
      await this.woo.updateOrder(order.store, credentials, order.externalId, { meta_data: [{ key: '_whatsapp_cod_status', value: word }], ...(data.cancel ? { status: 'cancelled' } : {}) });
    }
  }

  /**
   * Feature 008 (R5): an order paid through its pay link is marked paid in the store. A refusal (the store
   * says no, or our access lacks the permission) is kept as the connection's warning and not retried;
   * other failures throw to be retried.
   */
  async markPaid(orderId: string): Promise<void> {
    const order = await this.prisma.storeOrder.findUnique({ where: { id: orderId }, include: { store: true } });
    if (!order || order.store.status === 'DISCONNECTED') return;
    try {
      if (order.store.platform === 'SHOPIFY') {
        const token = await this.shopify.tokenFor(order.store);
        await this.shopify.markOrderPaid(order.store, token, order.externalId);
      } else {
        const credentials = this.http.open<WooCredentials>(order.store.credentialsEncrypted);
        await this.woo.updateOrder(order.store, credentials, order.externalId, { set_paid: true });
      }
    } catch (error) {
      const refused = error instanceof StoreApiError && (error.status === null || (error.status >= 400 && error.status < 500 && error.status !== 429));
      if (!refused) throw error;
      const reason = `Order ${order.orderNumber} was paid on WhatsApp, but the store did not mark it paid: ${error.message}`.slice(0, 200);
      await this.prisma.storeConnection.update({ where: { id: order.storeId }, data: { lastError: reason } });
      this.logger.warn({ orderId, storeId: order.storeId }, 'The store refused to mark a paid order paid');
    }
  }
}
