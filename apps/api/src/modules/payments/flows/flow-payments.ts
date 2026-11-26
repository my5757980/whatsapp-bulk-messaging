import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { toMinorUnits } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PaymentRequest } from '../../../generated/prisma/client.js';
import type { FlowPaymentRequest, FlowPaymentsPort } from '../../flows/engine/ports.js';
import { FlowSessionService } from '../../flows/engine/session.service.js';
import { isLive } from '../../inbox/conversations/window.js';
import { PaymentGatewayService } from '../gateway/payment-gateway.service.js';
import { PaymentEffects, type PaymentChange } from '../requests/payment-effects.js';
import { PaymentRequestsService } from '../requests/payment-requests.service.js';
import { PaymentSender } from '../requests/payment-sender.js';
import { PaymentSettingsService } from '../settings/payment-settings.service.js';

// Payment steps of chatbot flows (feature 008 US3, FR-038, research R13): the FLOW_PAYMENTS port the
// session service calls after commit, and the hook that resumes the waiting session when its request
// is paid (next) or expires or is cancelled (onNotPaid). Only a session's latest request resumes it.
// FlowSessionService is looked up lazily: it depends on this port, so a constructor dependency would
// be circular.

@Injectable()
export class FlowPayments implements FlowPaymentsPort, OnModuleInit {
  private readonly logger = new Logger(FlowPayments.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly settings: PaymentSettingsService,
    private readonly requests: PaymentRequestsService,
    private readonly sender: PaymentSender,
    private readonly effects: PaymentEffects,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.effects.registerHook((request, changes) => this.resumeSession(request, changes));
  }

  async request(input: FlowPaymentRequest): Promise<{ ok: true; requestId: string } | { ok: false; reason: string }> {
    const access = await this.gateway.access();
    if (!access || access.row.status !== 'CONNECTED') return { ok: false, reason: 'Stripe is not connected' };
    if (!input.amount) return { ok: false, reason: 'the payment step has no amount for this contact' };
    const chat = await this.prisma.conversation.findUnique({
      where: { id: input.conversationId },
      select: { numberId: true, lastCustomerMessageAt: true, contact: { select: { id: true, name: true, phoneE164: true } }, number: { select: { wabaId: true } } },
    });
    if (!chat?.contact?.phoneE164) return { ok: false, reason: 'the chat has no contact to ask' };
    const settings = await this.settings.row();
    const amountMinor = 'minor' in input.amount ? input.amount.minor : toMinorUnits(input.amount.major, access.currency);
    try {
      const live = isLive(chat.lastCustomerMessageAt);
      const template = live ? null : await this.sender.paymentTemplate(settings, chat.number.wabaId);
      if (!live && !template) return { ok: false, reason: 'the reply window has closed and no payment template is set' };
      const row = await this.requests.create({
        access,
        settings,
        source: 'FLOW',
        amountMinor,
        description: input.description || 'Payment',
        expiresInMinutes: input.expiryMinutes,
        contactId: chat.contact.id,
        conversationId: input.conversationId,
        phoneE164: chat.contact.phoneE164,
        customerName: chat.contact.name,
        flowSessionId: input.sessionId,
        isTest: input.isTest,
      });
      if (live) await this.sender.automatic(input.conversationId, chat.numberId, row, settings);
      else await this.sender.template({ conversationId: input.conversationId, numberId: chat.numberId, contactId: chat.contact.id }, row, template!, settings.templateMapping, { automatic: true });
      return { ok: true, requestId: row.id };
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : 'the request could not be made' };
    }
  }

  private async resumeSession(request: PaymentRequest, changes: PaymentChange[]): Promise<void> {
    if (request.source !== 'FLOW' || !request.flowSessionId) return;
    const paid = changes.includes('PAID');
    if (!paid && !changes.includes('EXPIRED') && !changes.includes('CANCELLED')) return;
    const latest = await this.prisma.paymentRequest.findFirst({ where: { flowSessionId: request.flowSessionId }, orderBy: { createdAt: 'desc' }, select: { id: true } });
    if (latest?.id !== request.id) return;
    const session = await this.prisma.flowSession.findUnique({ where: { id: request.flowSessionId }, select: { status: true, wait: true, waitToken: true } });
    if (!session || session.status !== 'RUNNING' || session.wait !== 'PAYMENT') return;
    const sessions = this.moduleRef.get(FlowSessionService, { strict: false });
    await sessions.resume(request.flowSessionId, { kind: 'payment', token: session.waitToken, paid });
    this.logger.log({ sessionId: request.flowSessionId, paid }, 'Flow session resumed by its payment');
  }
}
