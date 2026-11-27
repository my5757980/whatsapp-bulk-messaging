import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
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
import { DripLeaving } from '../growth/drips/drip-leaving.js';
import { StatusHandler } from '../webhooks/handlers/status.handler.js';
import { decideSendFailure, preSendCheck } from './send-outcome.js';
import { deliveryDeadline, sendExpiry } from './send-expiry.js';
import { OFFER_ENDS_PARAM } from './template-payload.builder.js';
import { FLOW_TOKEN_PARAM, HEADER_MEDIA_URL_PARAM, authenticationPayload, buildTemplatePayload, headerMediaType } from './template-payload.builder.js';
import { PlatformEvents } from '../integrations/webhooks/platform-events.js';
import { TEMPLATE_FORM_TOKENS, type TemplateFormTokensPort } from './template-form-tokens.port.js';
import { HEADER_MEDIA_ASSET_PARAM } from './template-send-rules.js';

/** Blocking codes caused by the number's credentials or account (research R9). */
export const NUMBER_BLOCKING = new Set([190, 10, 368, 133010]);
/** Meta: the number is not on WhatsApp (or cannot receive messages). */
const INVALID_NUMBER_CODE = 131026;
/** Blocking codes that tell us the template's new state. */
const TEMPLATE_STATE: Readonly<Record<number, 'PAUSED' | 'DISABLED'>> = { 132015: 'PAUSED', 132016: 'DISABLED' };

export interface SendJobData {
  messageId: string;
  /** Feature 009: the encrypted one-time code of an OTP job. */
  codeEnc?: string;
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
    private readonly drips: DripLeaving,
    private readonly platformEvents: PlatformEvents,
    @Optional() @Inject(TEMPLATE_FORM_TOKENS) private readonly formTokens?: TemplateFormTokensPort,
  ) {}

  /**
   * @param attempt 1-based attempt number of this job
   * @param codeEnc a one-time code from the job, encrypted (feature 009, research R4)
   */
  async process(messageId: string, attempt: number, codeEnc?: string): Promise<SendOutcome> {
    const outcome = await this.send(messageId, attempt, codeEnc);
    // Feature 009: one-time code status for the company system (send-time failures; webhooks do the rest).
    if (outcome.result === 'failed' || outcome.result === 'cancelled') await this.otpEvent(messageId);
    return outcome;
  }

  private async otpEvent(messageId: string): Promise<void> {
    const m = await this.prisma.message.findUnique({ where: { id: messageId }, select: { origin: true, status: true, failureCode: true, failureReason: true, failedAt: true } });
    if (m?.origin !== 'OTP') return;
    await this.platformEvents.otpStatus(this.prisma, messageId).catch((error: unknown) => this.logger.warn({ messageId, err: (error as Error).message }, 'Could not record the code status event'));
  }

  private async send(messageId: string, attempt: number, codeEnc?: string): Promise<SendOutcome> {
    const m = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: {
        campaign: { select: { id: true, state: true, headerMediaAssetId: true, cardMedia: true } },
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

    // Feature 009 (research R7, R8): past the time-to-live in our queue, or after the offer's end: not sent.
    const offerEnds = Number(((m.resolvedParams ?? {}) as Record<string, string>)[OFFER_ENDS_PARAM] ?? NaN);
    const expiry = sendExpiry({ createdAt: m.createdAt, ttlSeconds: m.template.ttlSeconds, offerEndsAtMs: Number.isFinite(offerEnds) ? offerEnds : null }, new Date());
    if (expiry.expire) {
      await this.transition(m.id, 'QUEUED', { status: 'EXPIRED', expiredReason: expiry.reason }, 'EXPIRED', `${m.id}:expired`, { reason: expiry.reason });
      this.metrics.messagesTotal.inc({ status: 'EXPIRED', number: m.number.phoneNumberId });
      return { result: 'cancelled' };
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
      // A form (FLOW) button carries the recipient's signed form token (feature 008 US7).
      const flowButton = ((components.find((c) => c.type.toUpperCase() === 'BUTTONS') as unknown as { buttons?: Array<{ type: string; flow_id?: string }> } | undefined)?.buttons ?? []).find((b) => b.type.toUpperCase() === 'FLOW');
      const flowToken = flowButton?.flow_id && m.contactId && this.formTokens ? await this.formTokens.forMessage(m.id, m.contactId, flowButton.flow_id) : null;
      // Feature 009: a one-time code goes only from the decrypted job into Meta's payload (research R4).
      if (m.template.kind === 'AUTHENTICATION') {
        if (!codeEnc) throw new Error('The one-time code is missing from the send job');
        ({ waMessageId } = await this.meta.sendTemplate(this.cipher.decrypt(m.number.accessTokenEnc), m.number.phoneNumberId, authenticationPayload(m.phoneE164, m.template, this.cipher.decrypt(codeEnc))));
        return this.sent(m, waMessageId);
      }
      // Feature 009 (research R6): carousel cards, from the campaign's choice or the template's samples.
      const cardMedia = m.template.kind === 'CAROUSEL' ? await this.cardMedia(m.template, (m.campaign?.cardMedia ?? null) as Array<{ cardIndex: number; mediaAssetId: string }> | null, m.number) : undefined;
      const payload = buildTemplatePayload({
        to: m.phoneE164,
        template: { name: m.template.name, language: m.template.language, parameterFormat: m.template.parameterFormat, components },
        params: { ...((m.resolvedParams ?? {}) as Record<string, string>), ...(flowToken ? { [FLOW_TOKEN_PARAM]: flowToken } : {}) },
        ...(headerMedia ? { headerMedia } : {}),
        ...(cardMedia ? { cardMedia } : {}),
      });
      ({ waMessageId } = await this.meta.sendTemplate(this.cipher.decrypt(m.number.accessTokenEnc), m.number.phoneNumberId, payload));
    } catch (error) {
      return this.handleFailure(m, error, attempt);
    }
    return this.sent(m, waMessageId);
  }

  private async sent(m: { id: string; origin: string; number: { phoneNumberId: string }; template: { ttlSeconds: number | null; ttlAppliedBy: string | null } }, waMessageId: string): Promise<SendOutcome> {
    const now = new Date();
    // Feature 009 (research R8): the expired sweep reads expiresAt for TTLs that Meta applies.
    const expiresAt = deliveryDeadline(m.template, now);
    await this.prisma.message.updateMany({ where: { id: m.id, status: 'SENDING' }, data: { status: 'SENT', waMessageId, sentAt: now, ...(expiresAt ? { expiresAt } : {}) } });
    await this.event(m.id, 'SENT_ACCEPTED', `${m.id}:accepted`, { waMessageId }, now);
    this.metrics.messagesTotal.inc({ status: 'SENT', number: m.number.phoneNumberId });
    if (m.origin === 'INBOX') this.metrics.inboxMessagesTotal.inc({ direction: 'out', kind: 'template' });
    await this.statuses.applyBuffered(waMessageId);
    // Show the template in the contact's live chat on this number (002 R2); never fails the send.
    // One-time codes have no contact and stay out of live chat (feature 009).
    if (m.origin !== 'OTP') await this.timeline.appendRef(m.id).catch((error: unknown) =>
      this.logger.warn({ messageId: m.id, err: (error as Error).message }, 'Could not add the message to live chat'),
    );
    return { result: 'sent', waMessageId };
  }

  /** The Meta media id of each carousel card on this number (the 001 media cache). */
  private async cardMedia(template: { components: unknown; options: unknown }, chosen: Array<{ cardIndex: number; mediaAssetId: string }> | null, number: Parameters<MediaService['ensureMetaMediaId']>[1]) {
    const components = (Array.isArray(template.components) ? template.components : []) as Array<{ type: string; cards?: Array<{ components?: Array<{ type: string; format?: string }> }> }>;
    const cards = components.find((c) => c.type.toUpperCase() === 'CAROUSEL')?.cards ?? [];
    const samples = (((template.options ?? {}) as { cards?: Array<{ sampleMediaAssetId?: string | null }> }).cards ?? []);
    const result: Array<{ type: 'image' | 'video'; id: string }> = [];
    for (const [i, card] of cards.entries()) {
      const assetId = chosen?.find((c) => c.cardIndex === i)?.mediaAssetId ?? samples[i]?.sampleMediaAssetId;
      if (!assetId) throw new Error(`Card ${i + 1} has no media`);
      const format = (card.components ?? []).find((p) => p.type.toUpperCase() === 'HEADER')?.format?.toUpperCase();
      result.push({ type: format === 'VIDEO' ? 'video' : 'image', id: await this.media.ensureMetaMediaId(assetId, number) });
    }
    return result;
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
    const outcome = await this.fail(m.id, 'SENDING', decision.code, decision.reason, attempt, m.number.phoneNumberId);
    // A drip step to a number not on WhatsApp ends that drip for the contact (feature 005, FR-031).
    if (m.origin === 'DRIP' && decision.code === INVALID_NUMBER_CODE) await this.drips.onInvalidNumber(m.id);
    return outcome;
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
