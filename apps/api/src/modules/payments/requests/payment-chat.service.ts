import { HttpStatus, Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PaymentRequest, PaymentSettings } from '../../../generated/prisma/client.js';
import type { AuditActor } from '../../audit/audit.service.js';
import type { ConversationRow } from '../../inbox/conversations/conversation-views.js';
import { ConversationsService } from '../../inbox/conversations/conversations.service.js';
import type { Viewer } from '../../inbox/conversations/visibility.js';
import { isLive } from '../../inbox/conversations/window.js';
import { SessionSendService } from '../../inbox/messages/session-send.service.js';
import { PaymentGatewayService } from '../gateway/payment-gateway.service.js';
import { PaymentSettingsService } from '../settings/payment-settings.service.js';
import { PaymentRequestsService, type CreateRequestInput } from './payment-requests.service.js';
import { PaymentSender } from './payment-sender.js';

// Payment requests from live chat (feature 008 US2, FR-007, FR-008, FR-014): a member asks in a chat
// they may reply in, with a role the settings allow; in the window the Pay now message goes like a
// reply (it takes the chat), outside it the payment template. Cancel and send again follow the same
// visibility rules. HTTP app only: it needs the 002 reply path.

export type PaymentViewer = Viewer & { permissions?: ReadonlySet<string> };

@Injectable()
export class PaymentChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayService,
    private readonly settings: PaymentSettingsService,
    private readonly requests: PaymentRequestsService,
    private readonly sender: PaymentSender,
    private readonly sessionSend: SessionSendService,
    private readonly conversations: ConversationsService,
  ) {}

  /** POST /inbox/conversations/{id}/payment-requests (US2). */
  async createFromChat(viewer: PaymentViewer, conversationId: string, input: CreateRequestInput) {
    const settings = await this.settings.row();
    if (!settings.requestRoles.includes(viewer.role)) throw new AppError(HttpStatus.FORBIDDEN, 'ROLE_NOT_ALLOWED', 'Your role may not request payments (Payments > Settings)');
    const chat = await this.sessionSend.prepare(viewer, conversationId, { requireWindow: false });
    const live = isLive(chat.lastCustomerMessageAt);
    const template = live ? null : await this.sender.paymentTemplate(settings, await this.wabaOf(chat));
    if (!live && !template) throw AppError.conflict('The 24-hour window has closed and no payment template is set (Payments > Settings)', 'WINDOW_CLOSED_NO_TEMPLATE');
    const access = await this.gateway.requireReady();
    const row = await this.requests.create({
      access,
      settings,
      source: 'INBOX',
      amountMinor: input.amountMinor,
      description: input.description,
      reference: input.reference ?? null,
      expiresInMinutes: input.expiresInMinutes ?? settings.defaultExpiryMinutes,
      contactId: chat.contact?.id ?? null,
      conversationId: chat.id,
      phoneE164: chat.contact?.phoneE164 ?? null,
      customerName: chat.contact?.name ?? null,
      createdById: viewer.id,
      tagId: input.tagId ?? null,
      flowId: input.flowId ?? null,
    });
    await this.send(viewer, chat, row, settings);
    return this.requests.dto(row.id);
  }

  async cancel(viewer: PaymentViewer, id: string, actor: AuditActor) {
    const row = await this.prisma.paymentRequest.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Payment request not found');
    await this.mayAct(viewer, row);
    return this.requests.cancel(id, actor);
  }

  /** Send a waiting request again (a new message, the same request and link). */
  async resend(viewer: PaymentViewer, id: string) {
    const row = await this.prisma.paymentRequest.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Payment request not found');
    if (row.status !== 'WAITING' || row.expiresAt <= new Date()) throw AppError.conflict('Only waiting requests can be sent again', 'NOT_WAITING');
    if (!row.conversationId || !row.contactId) throw AppError.conflict('This request has no chat to send it to', 'NOT_WAITING');
    const settings = await this.settings.row();
    const chat = await this.sessionSend.prepare(viewer, row.conversationId, { requireWindow: false });
    await this.send(viewer, chat, row, settings);
    return this.requests.dto(id);
  }

  private async send(viewer: PaymentViewer, chat: ConversationRow, row: PaymentRequest, settings: PaymentSettings): Promise<void> {
    if (isLive(chat.lastCustomerMessageAt)) {
      const item = await this.sessionSend.sendPrepared(viewer, chat, this.sender.outgoing(row, settings, await this.sender.text(settings, row)));
      await this.prisma.paymentRequest.update({ where: { id: row.id }, data: { chatItemId: item.id } });
      return;
    }
    const template = await this.sender.paymentTemplate(settings, await this.wabaOf(chat));
    if (!template) throw AppError.conflict('The 24-hour window has closed and no payment template is set (Payments > Settings)', 'WINDOW_CLOSED_NO_TEMPLATE');
    if (!row.contactId) throw AppError.conflict('This request has no contact to send it to', 'NOT_WAITING');
    await this.sender.template({ conversationId: chat.id, numberId: chat.numberId, contactId: row.contactId }, row, template, settings.templateMapping, { sentByUserId: viewer.id });
  }

  /** Members may act on requests of chats they can see, or that they made; payments.manage on all. */
  private async mayAct(viewer: PaymentViewer, row: PaymentRequest): Promise<void> {
    if (viewer.permissions?.has('payments.manage') || row.createdById === viewer.id) return;
    if (!row.conversationId) throw AppError.forbidden('Only admins may change this request');
    try {
      await this.conversations.loadVisible(viewer, row.conversationId);
    } catch {
      throw AppError.forbidden('You cannot see the chat of this request');
    }
  }

  private async wabaOf(chat: ConversationRow): Promise<string> {
    const number = await this.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: chat.numberId }, select: { wabaId: true } });
    return number.wabaId;
  }
}
