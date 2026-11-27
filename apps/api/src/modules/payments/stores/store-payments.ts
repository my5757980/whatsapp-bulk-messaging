import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { amountProblem, isStale, orderFieldValues, resolveOrderValues, toMinorUnits, type OrderVariableSource } from '@wbm/shared';
import { z } from 'zod';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import type { PaymentRequest } from '../../../generated/prisma/client.js';
import { STORE_MARK_PAID_JOB } from '../../integrations/stores/cod.service.js';
import type { StorePayLinkInput, StorePaymentsPort } from '../../integrations/stores/store-payments.port.js';
import { StoreMessages } from '../../integrations/stores/store-messages.js';
import { PaymentGatewayService } from '../gateway/payment-gateway.service.js';
import { PaymentEffects, type PaymentChange } from '../requests/payment-effects.js';
import { PaymentRequestsService } from '../requests/payment-requests.service.js';
import { PaymentSender } from '../requests/payment-sender.js';
import { PaymentSettingsService } from '../settings/payment-settings.service.js';

// The store PAY_LINK automation (feature 008 US3, FR-011, research R5): an UNPAID order (and a COD
// order when the admin chose "pay online instead") gets the automation's template with a Pay now link
// for the order total, once. When it is paid the order shows paid, a waiting COD question closes, and
// the order is marked paid in the store (a retried job on the `stores` queue; a refusal is a warning).

export const PayLinkSettingsSchema = z
  .object({
    includeCod: z.boolean(),
    expiryMinutes: z.number().int().min(30).max(43_200),
  })
  .partial()
  .strict();

interface Step {
  templateId: string;
  variableMapping: Record<string, OrderVariableSource>;
}

@Injectable()
export class StorePayments implements StorePaymentsPort, OnModuleInit {
  private readonly logger = new Logger(StorePayments.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly settings: PaymentSettingsService,
    private readonly requests: PaymentRequestsService,
    private readonly sender: PaymentSender,
    private readonly effects: PaymentEffects,
    private readonly messages: StoreMessages,
    private readonly queues: QueueRegistry,
  ) {}

  onModuleInit(): void {
    this.effects.registerHook((request, changes) => this.onChange(request, changes));
  }

  async payLink({ store, order, facts, phone, contact }: StorePayLinkInput): Promise<void> {
    if (facts.cancelled || facts.paid || facts.paymentKind === 'PREPAID') return;
    if (await this.messages.claimed(order.id, 'PAY_LINK')) return;
    const skip = (reason: string) => this.messages.skip(order.id, 'PAY_LINK', reason).then(() => undefined);
    const automation = await this.prisma.storeAutomation.findUnique({ where: { storeId_kind: { storeId: store.id, kind: 'PAY_LINK' } } });
    // Turned off: remembered, so turning it on later never sends for orders placed before.
    const step = automation?.enabled ? ((automation.steps as unknown as Step[])[0] ?? null) : null;
    if (!automation || !step) return skip('off');
    const options = PayLinkSettingsSchema.safeParse(automation.settings ?? {});
    if (facts.paymentKind === 'COD' && !(options.success && options.data.includeCod)) return skip('cod');
    if (isStale(facts.updatedAt)) return skip('stale');
    if (!phone || !contact) return skip('no_phone');
    if (contact.blockedAt) return skip('blocked');
    if (contact.consentStatus === 'OPTED_OUT') return skip('opted_out');
    const access = await this.gateway.access();
    if (!access || access.row.status !== 'CONNECTED') return skip('gateway_not_ready');
    // The order is paid in its own currency, which must be the Stripe account's (R5).
    if (facts.currency.toLowerCase() !== access.currency) return skip('currency_mismatch');
    const template = await this.prisma.template.findUnique({ where: { id: step.templateId } });
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: store.numberId }, select: { connectionStatus: true, sendingEnabled: true, wabaId: true } });
    const button = template ? this.sender.payLinkButton(template) : -1;
    if (!template || template.status !== 'APPROVED' || !number || number.connectionStatus !== 'CONNECTED' || !number.sendingEnabled || number.wabaId !== template.wabaId || button < 0) {
      return skip('template_unavailable');
    }
    if (template.category === 'MARKETING' && contact.consentStatus !== 'OPTED_IN') return skip('no_opt_in');
    const settings = await this.settings.row();
    const amountMinor = toMinorUnits(Number(facts.total), access.currency);
    if (amountProblem(amountMinor, access.currency, Number(settings.maxAmountMinor))) return skip('amount_invalid');
    const buttonKey = `BUTTON.${button}.1`;
    const variables = ((Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>).map((v) => v.key).filter((key) => key !== buttonKey);
    const values = resolveOrderValues(variables, step.variableMapping, orderFieldValues(facts, store.name), { name: contact.name, phone: phone.e164 });
    if (!values.ok) return skip('missing_value');

    let row: PaymentRequest;
    try {
      row = await this.requests.create({
        access,
        settings,
        source: 'STORE_ORDER',
        amountMinor,
        description: `${store.name} order ${order.orderNumber}`.slice(0, 250),
        reference: order.orderNumber,
        expiresInMinutes: (options.success ? options.data.expiryMinutes : undefined) ?? settings.defaultExpiryMinutes,
        contactId: contact.id,
        conversationId: null,
        phoneE164: phone.e164,
        customerName: contact.name,
        storeOrderId: order.id,
      });
    } catch (error) {
      this.logger.warn({ orderId: order.id, err: error }, 'The pay link request for a store order failed');
      return skip('gateway_error');
    }
    const messageId = await this.messages.send({ store, order: { id: order.id, orderNumber: order.orderNumber }, kind: 'PAY_LINK', contactId: contact.id, phone, templateId: template.id, params: { ...values.params, [buttonKey]: row.code } });
    if (!messageId) {
      // Another event for the order sent its link first: this request is not needed.
      await this.prisma.paymentRequest.updateMany({ where: { id: row.id, status: 'WAITING' }, data: { status: 'CANCELLED', cancelledAt: new Date() } });
      return;
    }
    await this.prisma.paymentRequest.update({ where: { id: row.id }, data: { messageId } });
    await this.prisma.storeOrder.update({ where: { id: order.id }, data: { paymentRequestId: row.id } });
  }

  /** A paid pay link: the order shows paid, its COD question closes, and the store is told. */
  private async onChange(request: PaymentRequest, changes: PaymentChange[]): Promise<void> {
    if (!request.storeOrderId || !changes.includes('PAID')) return;
    const order = await this.prisma.storeOrder.findUnique({ where: { id: request.storeOrderId }, select: { id: true, paidViaLinkAt: true } });
    if (!order || order.paidViaLinkAt) return;
    await this.prisma.storeOrder.update({ where: { id: order.id }, data: { paidViaLinkAt: request.paidAt ?? new Date(), paymentRequestId: request.id } });
    await this.prisma.storeOrder.updateMany({ where: { id: order.id, codStatus: 'ASKED' }, data: { codStatus: 'CLOSED', codNextAt: null } });
    await this.queues.get(QUEUES.STORES).add(
      STORE_MARK_PAID_JOB,
      { orderId: order.id },
      { jobId: `store-mark-paid-${order.id}`, attempts: 6, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: 200 },
    );
  }
}
