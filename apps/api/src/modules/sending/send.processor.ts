import { Injectable, Logger } from '@nestjs/common';
import type { MetaTemplateComponent } from '@wbm/shared';
import { TokenCipher } from '../../common/crypto/token-cipher.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';
import { maskPhone } from '../../common/phone/phone.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { MessageEventType, MessageStatus, Prisma } from '../../generated/prisma/client.js';
import { CampaignsService } from '../campaigns/campaigns.service.js';
import { ChatTimelineService } from '../inbox/messages/chat-timeline.service.js';
import { MediaService } from '../media/media.service.js';
import { MetaGraphClient } from '../meta/meta-graph.client.js';
import { NumbersService } from '../numbers/numbers.service.js';
import { StatusHandler } from '../webhooks/handlers/status.handler.js';
import { decideSendFailure, preSendCheck } from './send-outcome.js';
import { HEADER_MEDIA_URL_PARAM, buildTemplatePayload, headerMediaType } from './template-payload.builder.js';
import { HEADER_MEDIA_ASSET_PARAM } from './template-send-rules.js';

/** Blocking codes caused by the number's credentials or account (research R9). */
export const NUMBER_BLOCKING = new Set([190, 10, 368, 133010]);
/** Blocking codes that tell us the template's new state. */
const TEMPLATE_STATE: Readonly<Record<number, 'PAUSED' | 'DISABLED'>> = { 132015: 'PAUSED', 132016: 'DISABLED' };

export interface SendJobData {
  messageId: string;
}

export type SendOutcome =
  | { result: 'sent'; waMessageId: string }
  | { result: 'retry'; reason: string }
  | { result: 'failed'; code: number | null; reason: string }
  | { result: 'blocked'; reason: string }
  | { result: 'skipped'; reason: string }
  | { result: 'requeued' }
  | { result: 'cancelled' }
  | { result: 'ignored' };

/**
 * Sends one message (T100, research R7/R9/R11). Campaign state, consent and the number's kill
 * switch are re-checked first; the message is claimed QUEUED -> SENDING with a conditional update
 * before Meta is called, so a re-delivered job can never send twice.
 */
@Injectable()
export class SendProcessor {
  private readonly logger = new Logger(SendProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly meta: MetaGraphClient,
    private readonly campaigns: CampaignsService,
    private readonly media: MediaService,
    private readonly statuses: StatusHandler,
    private readonly metrics: MetricsService,
    private readonly numbers: NumbersService,
    private readonly timeline: ChatTimelineService,
  ) {}

  /** @param attempt 1-based attempt number of this job */
  async process(messageId: string, attempt: number): Promise<SendOutcome> {
    const m = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        campaign: { select: { id: true, state: true, headerMediaAssetId: true } },
        number: true,
        template: true,
        contact: { select: { consentStatus: true } },
      },
    });
    if (!m || m.status !== 'QUEUED') return { result: 'ignored' };
    if (!m.phoneE164) {
      await this.transition(m.id, 'QUEUED', { status: 'CANCELLED' }, 'CANCELLED', `${m.id}:cancelled`);
      return { result: 'cancelled' };
    }

    const isCampaign = m.origin === 'CAMPAIGN';
    const decision = preSendCheck({
      messageStatus: m.status,
      campaignState: isCampaign ? (m.campaign?.state ?? 'CANCELLED') : null,
      sendingEnabled: m.number.sendingEnabled,
      consent: m.contact?.consentStatus ?? 'UNKNOWN',
      marketing: m.template.category === 'MARKETING',
    });

    switch (decision.action) {
      case 'ignore':
        return { result: 'ignored' };
      case 'cancel':
        await this.transition(m.id, 'QUEUED', { status: 'CANCELLED' }, 'CANCELLED', `${m.id}:cancelled`);
        return { result: 'cancelled' };
      case 'skip':
        await this.transition(m.id, 'QUEUED', { status: 'SKIPPED', skipReason: decision.reason }, 'SKIPPED', `${m.id}:skipped`);
        return { result: 'skipped', reason: decision.reason };
      case 'requeue':
        if (!isCampaign) return this.fail(m.id, 'QUEUED', null, 'Sending is turned off for this number', attempt, m.number.phoneNumberId);
        await this.transition(m.id, 'QUEUED', { status: 'PENDING' }, 'REQUEUED', `${m.id}:requeued:${Date.now()}`);
        if (decision.pauseReason && m.campaign) await this.campaigns.autoPause(m.campaign.id, decision.pauseReason);
        return { result: 'requeued' };
      case 'send':
        break;
    }

    if (m.number.connectionStatus !== 'CONNECTED') {
      if (!isCampaign) return this.fail(m.id, 'QUEUED', null, 'The WhatsApp number is not connected', attempt, m.number.phoneNumberId);
      await this.transition(m.id, 'QUEUED', { status: 'PENDING' }, 'REQUEUED', `${m.id}:requeued:${Date.now()}`);
      if (m.campaign) await this.campaigns.autoPause(m.campaign.id, 'number_unavailable');
      return { result: 'requeued' };
    }

    // Claim before calling Meta: only one job can move QUEUED -> SENDING.
    const claimed = await this.prisma.message.updateMany({
      where: { id: m.id, status: 'QUEUED' },
      data: { status: 'SENDING', attempts: { increment: 1 } },
    });
    if (!claimed.count) return { result: 'ignored' };

    let waMessageId: string;
    try {
      const components = (Array.isArray(m.template.components) ? m.template.components : []) as unknown as MetaTemplateComponent[];
      const mediaType = headerMediaType(components);
      const params = (m.resolvedParams ?? {}) as Record<string, string>;
      const headerMedia =
        mediaType && m.campaign?.headerMediaAssetId
          ? { type: mediaType, id: await this.media.ensureMetaMediaId(m.campaign.headerMediaAssetId, m.number) }
          : mediaType && params[HEADER_MEDIA_ASSET_PARAM]
            ? { type: mediaType, id: await this.media.ensureMetaMediaId(params[HEADER_MEDIA_ASSET_PARAM], m.number) }
            : mediaType && params[HEADER_MEDIA_URL_PARAM]
              ? { type: mediaType, link: params[HEADER_MEDIA_URL_PARAM] }
              : undefined;
      const payload = buildTemplatePayload({
        to: m.phoneE164,
        template: { name: m.template.name, language: m.template.language, parameterFormat: m.template.parameterFormat, components },
        params: (m.resolvedParams ?? {}) as Record<string, string>,
        ...(headerMedia ? { headerMedia } : {}),
      });
      ({ waMessageId } = await this.meta.sendTemplate(this.cipher.decrypt(m.number.accessTokenEnc), m.number.phoneNumberId, payload));
    } catch (error) {
      return this.handleFailure(m, error, attempt);
    }

    const now = new Date();
    await this.prisma.message.updateMany({ where: { id: m.id, status: 'SENDING' }, data: { status: 'SENT', waMessageId, sentAt: now } });
    await this.event(m.id, 'SENT_ACCEPTED', `${m.id}:accepted`, { waMessageId }, now);
    this.metrics.messagesTotal.inc({ status: 'SENT', number: m.number.phoneNumberId });
    await this.statuses.applyBuffered(waMessageId);
    // Show the template in the contact's live chat on this number (002 R2); never fails the send.
    await this.timeline.appendRef(m.id).catch((error: unknown) =>
      this.logger.warn({ messageId: m.id, err: (error as Error).message }, 'Could not add the message to live chat'),
    );
    return { result: 'sent', waMessageId };
  }

  private async handleFailure(
    m: { id: string; origin: string; campaign: { id: string } | null; phoneE164: string | null; numberId: string; templateId: string; number: { phoneNumberId: string } },
    error: unknown,
    attempt: number,
  ): Promise<SendOutcome> {
    const decision = decideSendFailure(error, attempt);
    this.metrics.sendErrorsTotal.inc({ code: String(decision.code ?? 'network') });
    this.logger.warn({ messageId: m.id, to: maskPhone(m.phoneE164), attempt, code: decision.code, action: decision.action }, 'Send failed');

    if (decision.action === 'retry') {
      await this.transition(m.id, 'SENDING', { status: 'QUEUED' }, 'RETRY_SCHEDULED', `${m.id}:retry:${attempt}`, { code: decision.code, reason: decision.reason });
      return { result: 'retry', reason: decision.reason };
    }
    if (decision.action === 'block' && decision.code !== null) {
      if (NUMBER_BLOCKING.has(decision.code)) await this.numbers.markUnavailable(m.numberId, decision.reason);
      const templateState = TEMPLATE_STATE[decision.code];
      if (templateState) await this.prisma.template.update({ where: { id: m.templateId }, data: { status: templateState } });
    }
    if (decision.action === 'block' && m.origin === 'CAMPAIGN' && m.campaign) {
      await this.transition(m.id, 'SENDING', { status: 'PENDING' }, 'REQUEUED', `${m.id}:requeued:${attempt}:${Date.now()}`, { code: decision.code });
      await this.campaigns.autoPause(m.campaign.id, decision.pauseReason);
      return { result: 'blocked', reason: decision.reason };
    }
    return this.fail(m.id, 'SENDING', decision.code, decision.reason, attempt, m.number.phoneNumberId);
  }

  private async fail(id: string, from: MessageStatus, code: number | null, reason: string, attempt: number, phoneNumberId: string): Promise<SendOutcome> {
    const now = new Date();
    await this.transition(id, from, { status: 'FAILED', failureCode: code, failureReason: reason, failedAt: now }, 'FAILED', `${id}:failed`, { code, reason, attempt });
    this.metrics.messagesTotal.inc({ status: 'FAILED', number: phoneNumberId });
    return { result: 'failed', code, reason };
  }

  /** Conditional status change plus its event; a lost race (status already changed) is a no-op. */
  private async transition(
    id: string,
    from: MessageStatus,
    data: Prisma.MessageUpdateManyMutationInput,
    type: MessageEventType,
    dedupeKey: string,
    payload: Record<string, unknown> = {},
  ): Promise<boolean> {
    const { count } = await this.prisma.message.updateMany({ where: { id, status: from }, data });
    if (count) await this.event(id, type, dedupeKey, payload);
    return count > 0;
  }

  private async event(messageId: string, type: MessageEventType, dedupeKey: string, payload: Record<string, unknown>, at = new Date()) {
    try {
      await this.prisma.messageEvent.create({ data: { messageId, type, occurredAt: at, dedupeKey, payload: payload as Prisma.InputJsonValue } });
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
}
