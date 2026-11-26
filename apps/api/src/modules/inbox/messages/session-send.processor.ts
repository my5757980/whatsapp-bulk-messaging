import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { UnrecoverableError, type Job } from 'bullmq';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { e164ToWaRecipient } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { MessageStatus, WhatsAppNumber } from '../../../generated/prisma/client.js';
import { MediaService } from '../../media/media.service.js';
import { MetaGraphClient, type SessionMessagePayload } from '../../meta/meta-graph.client.js';
import { NumbersService } from '../../numbers/numbers.service.js';
import type { SessionJobData } from '../../sending/send-jobs.js';
import { decideSendFailure } from '../../sending/send-outcome.js';
import { SendQueueManager } from '../../sending/send-queue.manager.js';
import { NUMBER_BLOCKING } from '../../sending/send.processor.js';
import { StatusHandler } from '../../webhooks/handlers/status.handler.js';
import { isLive } from '../conversations/window.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';
import { commerceInteractiveFor, ctaUrlFor, interactiveFor } from './interactive-payload.js';

export const WINDOW_CLOSED_REASON = 'The 24-hour reply window has closed — send a template';

export type SessionOutcome =
  | { result: 'sent'; waMessageId: string }
  | { result: 'retry'; reason: string }
  | { result: 'failed'; code: number | null; reason: string }
  | { result: 'ignored' };

/**
 * Sends queued live chat replies (T031, research R3), mirroring the campaign send rules:
 * claim before sending, re-check the window and the number at send time, retry only transient
 * errors, and never resend after an ambiguous network outcome.
 */
@Injectable()
export class SessionSendProcessor implements OnModuleInit {
  private readonly logger = new Logger(SessionSendProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly meta: MetaGraphClient,
    private readonly cipher: TokenCipher,
    private readonly numbers: NumbersService,
    private readonly statuses: StatusHandler,
    private readonly publisher: InboxPublisher,
    private readonly sendQueues: SendQueueManager,
    private readonly metrics: MetricsService,
    private readonly media: MediaService,
  ) {}

  onModuleInit(): void {
    this.sendQueues.registerJobHandler<SessionJobData, SessionOutcome>('session', (job) => this.run(job));
  }

  private async run(job: Job<SessionJobData>): Promise<SessionOutcome> {
    const outcome = await this.process(job.data.chatMessageId, job.attemptsMade + 1);
    if (outcome.result === 'retry') throw new Error(outcome.reason);
    if (outcome.result === 'failed') throw new UnrecoverableError(outcome.reason);
    return outcome;
  }

  async process(chatMessageId: string, attempt: number): Promise<SessionOutcome> {
    const item = await this.prisma.chatMessage.findUnique({
      where: { id: chatMessageId },
      include: { conversation: { include: { contact: { select: { phoneE164: true } }, number: true } } },
    });
    if (!item || item.kind !== 'SESSION_OUT' || item.status !== 'QUEUED') return { result: 'ignored' };
    const { conversation } = item;
    const { number } = conversation;
    const phone = conversation.contact?.phoneE164;
    if (!phone) return this.fail(item.id, 'QUEUED', null, 'The contact was deleted');
    if (!number.sendingEnabled) return this.fail(item.id, 'QUEUED', null, 'Sending is turned off for this number');
    if (number.connectionStatus !== 'CONNECTED') return this.fail(item.id, 'QUEUED', null, 'The WhatsApp number is not connected');
    // A reply queued just before the window closed is not sent after it (FR-014).
    if (!isLive(conversation.lastCustomerMessageAt)) return this.fail(item.id, 'QUEUED', null, WINDOW_CLOSED_REASON);

    const claimed = await this.prisma.chatMessage.updateMany({ where: { id: item.id, status: 'QUEUED' }, data: { status: 'SENDING', attempts: { increment: 1 } } });
    if (!claimed.count) return { result: 'ignored' };

    let waMessageId: string;
    try {
      ({ waMessageId } = await this.meta.sendSessionMessage(this.cipher.decrypt(number.accessTokenEnc), number.phoneNumberId, await this.payload(item, number, e164ToWaRecipient(phone))));
    } catch (error) {
      const decision = decideSendFailure(error, attempt);
      this.metrics.sendErrorsTotal.inc({ code: String(decision.code ?? 'network') });
      this.logger.warn({ chatMessageId: item.id, attempt, code: decision.code, action: decision.action }, 'Live chat reply failed');
      if (decision.action === 'retry') {
        await this.prisma.chatMessage.updateMany({ where: { id: item.id, status: 'SENDING' }, data: { status: 'QUEUED' } });
        return { result: 'retry', reason: decision.reason };
      }
      if (decision.action === 'block' && decision.code !== null && NUMBER_BLOCKING.has(decision.code)) {
        await this.numbers.markUnavailable(number.id, decision.reason);
      }
      return this.fail(item.id, 'SENDING', decision.code, decision.reason);
    }

    await this.prisma.chatMessage.updateMany({ where: { id: item.id, status: 'SENDING' }, data: { status: 'SENT', waMessageId, sentAt: new Date() } });
    this.metrics.messagesTotal.inc({ status: 'SENT', number: number.phoneNumberId });
    this.metrics.inboxMessagesTotal.inc({ direction: 'out', kind: item.contentType.toLowerCase() });
    await this.statuses.applyBuffered(waMessageId);
    await this.publisher.itemStatus(item.id);
    return { result: 'sent', waMessageId };
  }

  /** Graph payload for the reply (contracts/meta-graph-inbox.md §2): library files are uploaded once per number. */
  private async payload(
    item: { contentType: string; text: string | null; mediaAssetId: string | null; payload: unknown },
    number: WhatsAppNumber,
    to: string,
  ): Promise<SessionMessagePayload> {
    if (item.contentType === 'TEXT') return { to, type: 'text', text: { body: item.text ?? '', preview_url: true } };
    // Reply buttons and lists from chatbot flows (feature 003).
    if (item.contentType === 'BUTTONS' || item.contentType === 'LIST') return { to, type: 'interactive', interactive: { ...interactiveFor(item.contentType, item.text, item.payload) } };
    // The Pay now message (feature 008).
    if (item.contentType === 'PAYMENT_REQUEST') return { to, type: 'interactive', interactive: { ...ctaUrlFor(item.text, item.payload) } };
    // Product messages (feature 008 US5).
    if (item.contentType === 'PRODUCT' || item.contentType === 'PRODUCT_LIST' || item.contentType === 'CATALOG') {
      return { to, type: 'interactive', interactive: commerceInteractiveFor(item.contentType, item.text, item.payload) };
    }
    const data = (item.payload ?? {}) as { link?: string; fileName?: string };
    const source = item.mediaAssetId ? { id: await this.media.ensureMetaMediaId(item.mediaAssetId, number) } : { link: data.link };
    switch (item.contentType) {
      case 'AUDIO':
        return { to, type: 'audio', media: source };
      case 'DOCUMENT':
        return { to, type: 'document', media: { ...source, ...(item.text ? { caption: item.text } : {}), ...(data.fileName ? { filename: data.fileName } : {}) } };
      default:
        return { to, type: item.contentType === 'VIDEO' ? 'video' : 'image', media: { ...source, ...(item.text ? { caption: item.text } : {}) } };
    }
  }

  private async fail(id: string, from: MessageStatus, code: number | null, reason: string): Promise<SessionOutcome> {
    await this.prisma.chatMessage.updateMany({ where: { id, status: from }, data: { status: 'FAILED', failureCode: code, failureReason: reason, failedAt: new Date() } });
    await this.publisher.itemStatus(id);
    return { result: 'failed', code, reason };
  }
}
