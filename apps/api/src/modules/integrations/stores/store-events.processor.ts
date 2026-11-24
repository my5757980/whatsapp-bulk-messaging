import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import {
  choosePhone,
  isStale,
  mapShopifyFulfillment,
  mapShopifyOrder,
  mapWooOrder,
  orderFieldValues,
  orderStages,
  resolveOrderValues,
  type MetaTemplateComponent,
  type OrderStage,
  type OrderVariableSource,
  type StoreOrderFacts,
} from '@wbm/shared';
import { normalizePhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import type { StoreConnection } from '../../../generated/prisma/client.js';
import { ConsentService } from '../../contacts/consent.service.js';
import { ContactsService } from '../../contacts/contacts.service.js';
import { normaliseTag } from '../../contacts/tags.controller.js';
import { DripEvents } from '../../growth/drips/drip-events.js';
import { JourneyService } from '../../inbox/journey/journey.service.js';
import { headerMediaType } from '../../sending/template-payload.builder.js';
import { ShopifyClient } from './shopify/shopify.client.js';
import { STORE_EVENT_JOB } from './store-events-inbox.js';
import { StoreMessages } from './store-messages.js';
import { plainStoreError } from './store-http.js';

// Store events, one at a time (feature 006 US4, FR-026 - FR-033, research R9): the order is upserted
// with its contact (store tag; opt-in with source STORE only when the store's consent text is
// confirmed), the stages it reached get their notification at most once, and the drip starting events
// ORDER_PLACED and ORDER_DELIVERED are written.

type Store = StoreConnection;
export type EventOutcome = 'processed' | 'ignored' | 'failed';

interface Step {
  templateId: string;
  variableMapping: Record<string, OrderVariableSource>;
}

const SHOPIFY_ORDER_TOPICS = new Set(['orders/create', 'orders/updated', 'orders/cancelled', 'orders/paid', 'orders/fulfilled', 'orders/partially_fulfilled']);
const SHOPIFY_FULFILLMENT_TOPICS = new Set(['fulfillments/create', 'fulfillments/update']);
const WOO_ORDER_TOPICS = new Set(['order.created', 'order.updated', 'order.restored']);

@Injectable()
export class StoreEventsProcessor implements OnModuleInit {
  private readonly logger = new Logger(StoreEventsProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly shopify: ShopifyClient,
    private readonly contacts: ContactsService,
    private readonly consent: ConsentService,
    private readonly journey: JourneyService,
    private readonly dripEvents: DripEvents,
    private readonly messages: StoreMessages,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.STORES, STORE_EVENT_JOB, async (job) => {
      await this.process((job.data as { eventId: string }).eventId);
    });
  }

  /** Processes one saved event; failures are recorded on the event (the reconciler fetches the order again later). */
  async process(eventId: bigint | string | number): Promise<EventOutcome> {
    const id = BigInt(eventId);
    const event = await this.prisma.storeEvent.findUnique({ where: { id }, include: { store: true } });
    if (!event || event.status !== 'RECEIVED') return 'ignored';
    try {
      const outcome = await this.handle(event.store, event.topic, event.payload);
      await this.prisma.storeEvent.update({ where: { id }, data: { status: outcome === 'ignored' ? 'IGNORED' : 'PROCESSED', processedAt: new Date() } });
      return outcome;
    } catch (error) {
      this.logger.warn({ err: error, eventId: id.toString(), storeId: event.storeId }, 'Store event failed');
      await this.prisma.storeEvent.update({ where: { id }, data: { status: 'FAILED', error: plainStoreError(error).slice(0, 200), processedAt: new Date() } });
      return 'failed';
    }
  }

  private async handle(store: Store, topic: string, payload: unknown): Promise<EventOutcome> {
    if (store.status === 'DISCONNECTED') return 'ignored';
    if (store.platform === 'SHOPIFY') {
      if (SHOPIFY_ORDER_TOPICS.has(topic)) return this.apply(store, mapShopifyOrder(payload));
      if (SHOPIFY_FULFILLMENT_TOPICS.has(topic)) {
        // Fulfillment webhooks carry only the fulfillment: read the whole order again.
        const fulfillment = mapShopifyFulfillment(payload);
        if (!fulfillment) return 'ignored';
        const token = await this.shopify.tokenFor(store);
        const order = await this.shopify.order(store, token, fulfillment.orderExternalId);
        return order ? this.apply(store, mapShopifyOrder(order)) : 'ignored';
      }
      return 'ignored';
    }
    if (WOO_ORDER_TOPICS.has(topic)) return this.apply(store, mapWooOrder(payload));
    return 'ignored';
  }

  /** Upserts the order and its contact, then sends or skips each stage reached for the first time. */
  async apply(store: Store, facts: StoreOrderFacts): Promise<EventOutcome> {
    if (!facts.externalId) return 'ignored';
    const existing = await this.prisma.storeOrder.findUnique({ where: { storeId_externalId: { storeId: store.id, externalId: facts.externalId } } });
    // An older event than what we know (stores do not promise order).
    if (existing && existing.storeUpdatedAt.getTime() > new Date(facts.updatedAt).getTime()) return 'ignored';

    const phone = choosePhone(facts.phones, store.defaultCountry, (raw, country) => normalizePhone(raw, country)?.e164 ?? null);
    const recipient = phone ? normalizePhone(phone.e164, store.defaultCountry) : null;
    const contact = phone && recipient ? await this.contactFor(store, phone.e164, facts) : null;
    const data = {
      orderNumber: facts.orderNumber.slice(0, 40),
      contactId: contact?.id ?? null,
      phoneE164: phone?.e164 ?? null,
      phoneSource: phone?.source ?? null,
      customerName: facts.customerName?.slice(0, 120) ?? null,
      total: facts.total,
      currency: facts.currency.slice(0, 3),
      paymentKind: facts.paymentKind,
      status: facts.status.slice(0, 30),
      placedAt: new Date(facts.placedAt),
      storeUpdatedAt: new Date(facts.updatedAt),
    };
    const order = existing
      ? await this.prisma.storeOrder.update({ where: { id: existing.id }, data })
      : await this.prisma.storeOrder.create({ data: { storeId: store.id, externalId: facts.externalId.slice(0, 64), ...data } });

    if (!existing && contact && !facts.cancelled) {
      // A new order: the journey entry, and drips that start on orders (feature 005 outbox).
      await this.dripEvents.recordOrderEvent(this.prisma, 'ORDER_PLACED', [contact.id]);
      await this.journey.recordForContact(contact.id, {
        type: 'ORDER_PLACED',
        actorType: 'SYSTEM',
        data: { store: store.name, platform: store.platform, orderNumber: facts.orderNumber, total: `${facts.total} ${facts.currency}` },
      });
    }

    const stages = orderStages(facts, store.platform, { shippedStatus: store.shippedStatus, deliveredStatus: store.deliveredStatus });
    if (!stages.length) return 'processed';
    const automations = await this.prisma.storeAutomation.findMany({ where: { storeId: store.id, kind: { in: stages } } });
    for (const stage of stages) {
      if (await this.messages.claimed(order.id, stage)) continue;
      const automation = automations.find((a) => a.kind === stage && a.enabled);
      const step = automation ? ((automation.steps as unknown as Step[])[0] ?? null) : null;
      const handled = await this.notify(store, { id: order.id, orderNumber: order.orderNumber }, stage, step, facts, phone && recipient ? { e164: phone.e164, country: recipient.country } : null, contact);
      if (handled && stage === 'ORDER_DELIVERED' && contact) await this.dripEvents.recordOrderEvent(this.prisma, 'ORDER_DELIVERED', [contact.id]);
    }
    return 'processed';
  }

  /** Sends the stage's notification or records why not; false when another event handled it first. */
  private async notify(
    store: Store,
    order: { id: string; orderNumber: string },
    kind: OrderStage,
    step: Step | null,
    facts: StoreOrderFacts,
    phone: { e164: string; country: string } | null,
    contact: { id: string; name: string | null; consentStatus: string; blockedAt: Date | null } | null,
  ): Promise<boolean> {
    // Turned off: remembered too, so turning it on later never sends for stages reached before.
    if (!step) return this.messages.skip(order.id, kind, 'off');
    if (isStale(facts.updatedAt)) return this.messages.skip(order.id, kind, 'stale');
    if (!phone || !contact) return this.messages.skip(order.id, kind, 'no_phone');
    if (contact.blockedAt) return this.messages.skip(order.id, kind, 'blocked');
    if (contact.consentStatus === 'OPTED_OUT') return this.messages.skip(order.id, kind, 'opted_out');
    const template = await this.prisma.template.findUnique({ where: { id: step.templateId }, select: { status: true, category: true, variables: true, components: true, wabaId: true } });
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: store.numberId }, select: { connectionStatus: true, sendingEnabled: true, wabaId: true } });
    if (
      !template ||
      template.status !== 'APPROVED' ||
      !number ||
      number.connectionStatus !== 'CONNECTED' ||
      !number.sendingEnabled ||
      number.wabaId !== template.wabaId ||
      headerMediaType(template.components as unknown as MetaTemplateComponent[])
    ) {
      return this.messages.skip(order.id, kind, 'template_unavailable');
    }
    if (template.category === 'MARKETING' && contact.consentStatus !== 'OPTED_IN') return this.messages.skip(order.id, kind, 'no_opt_in');
    const variables = ((Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>).map((v) => v.key);
    const values = resolveOrderValues(variables, step.variableMapping, orderFieldValues(facts, store.name), { name: contact.name, phone: phone.e164 });
    if (!values.ok) return this.messages.skip(order.id, kind, 'missing_value');
    const messageId = await this.messages.send({ store, order, kind, contactId: contact.id, phone, templateId: step.templateId, params: values.params });
    return messageId !== null;
  }

  /** Finds or creates the contact with the store's tag; opts in only with confirmed consent text (FR-027). */
  private async contactFor(store: Store, e164: string, facts: StoreOrderFacts) {
    const tag = normaliseTag(store.customerTag);
    const select = { id: true, name: true, consentStatus: true, blockedAt: true, tags: { select: { tag: { select: { name: true } } } } } as const;
    let contact = await this.prisma.contact.findUnique({ where: { phoneE164: e164 }, select });
    if (!contact) {
      try {
        await this.contacts.create({ phone: e164, name: facts.customerName?.slice(0, 120) ?? null, tags: [tag] }, null, 'store');
      } catch (error) {
        // Created by a parallel event a moment ago.
        this.logger.debug({ err: error }, 'Contact creation raced');
      }
      contact = await this.prisma.contact.findUniqueOrThrow({ where: { phoneE164: e164 }, select });
    } else {
      const names = contact.tags.map((t) => t.tag.name);
      const changes = {
        ...(names.includes(tag) ? {} : { tags: [...names, tag] }),
        ...(!contact.name && facts.customerName ? { name: facts.customerName.slice(0, 120) } : {}),
      };
      if (Object.keys(changes).length) await this.contacts.update(contact.id, changes, null);
    }
    if (store.consentIsWhatsapp && facts.acceptsMarketing && contact.consentStatus === 'UNKNOWN') {
      await this.consent.setStatus(contact.id, 'OPTED_IN', 'STORE', { note: `${store.name}: checkout consent to WhatsApp messages`.slice(0, 500) });
    }
    return this.prisma.contact.findUniqueOrThrow({ where: { id: contact.id }, select: { id: true, name: true, consentStatus: true, blockedAt: true } });
  }
}
