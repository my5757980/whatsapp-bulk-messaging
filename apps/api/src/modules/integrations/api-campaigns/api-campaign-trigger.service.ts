import { HttpStatus, Injectable } from '@nestjs/common';
import { resolveApiValues, resolveAttributeValues, startOfLocalDay, type ApiVariableMapping, type MetaTemplateComponent } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { normalizePhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { ApiCampaign, Prisma } from '../../../generated/prisma/client.js';
import type { ApiKeyContext } from '../../public-api/api-key.guard.js';
import type { Answer } from '../../public-api/idempotent-responses.service.js';
import { PublicContactsService } from '../../public-api/public-contacts.service.js';
import { sendJobId } from '../../sending/dispatch-planner.js';
import { MAX_SEND_ATTEMPTS } from '../../sending/send-outcome.js';
import { HEADER_MEDIA_URL_PARAM, headerMediaType } from '../../sending/template-payload.builder.js';
import { HEADER_MEDIA_ASSET_PARAM } from '../../sending/template-send-rules.js';
import { SettingsService } from '../../settings/settings.service.js';
import { PlatformEvents } from '../webhooks/platform-events.js';
import { ApiCampaignPauser, selfPauseText, type SelfPauseReason } from './api-campaign-pauser.js';
import { templateVariableKeys } from './api-campaigns.service.js';

// Triggering an API campaign (feature 006 US3, FR-019 - FR-021, research R6):
// POST /api/v1/api-campaigns/{apiName}/messages. The message goes out like a 001 public API send
// (origin API, the number's send queue), with the campaign's id. Every call, sent or refused, is a
// trigger row, so results show refusals too.

const callValue = z.union([z.string().max(1024), z.number(), z.boolean()]).transform(String);

export const TriggerRequestSchema = z
  .object({
    phone: z.string().trim().min(1).max(32),
    name: z.string().trim().max(120).optional(),
    values: z.record(z.string().max(40), callValue).default({}),
    mediaUrl: z.url({ protocol: /^https$/ }).optional(),
    optIn: z.object({ sourceNote: z.string().trim().min(3).max(500) }).strict().optional(),
  })
  .strict();
export type TriggerRequest = z.infer<typeof TriggerRequestSchema>;

export interface TriggerAccepted {
  messageId: string;
  contactId: string;
}

type Db = Prisma.TransactionClient | PrismaService;
type Campaign = Pick<ApiCampaign, 'id' | 'name' | 'apiName'>;

const notSent = (reason: string, message: string) => new AppError(HttpStatus.CONFLICT, 'NOT_SENT', message, undefined, { reason });

function notLive(status: string, pausedReason: string | null): AppError {
  const state = status.toLowerCase();
  const message =
    status === 'PAUSED'
      ? (selfPauseText(pausedReason) ? `This API campaign paused itself because ${selfPauseText(pausedReason)}` : 'This API campaign is paused')
      : status === 'STOPPED'
        ? 'This API campaign is stopped'
        : 'This API campaign is not live yet';
  return new AppError(HttpStatus.CONFLICT, 'NOT_LIVE', message, undefined, { reason: state, pausedReason });
}

function missingValue(r: { variable: string; missing: string; from: 'value' | 'field' | 'mapping' }): AppError {
  const message =
    r.from === 'value'
      ? `The value "${r.missing}" is missing`
      : r.from === 'field'
        ? `The contact has no ${r.missing.replace(/^attributes\./, '')} for ${r.variable}`
        : `${r.variable} has no value source`;
  return new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'MISSING_VALUE', message, [{ field: r.from === 'value' ? `values.${r.missing}` : r.variable, issue: 'is required' }], {
    reason: 'missing_value',
  });
}

const dailyLimit = (limit: number) =>
  new AppError(HttpStatus.CONFLICT, 'DAILY_LIMIT', `This API campaign reached its daily limit of ${limit} messages`, undefined, { reason: 'daily_limit' });

class DailyLimitReached extends Error {}

@Injectable()
export class ApiCampaignTriggerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly settings: SettingsService,
    private readonly contacts: PublicContactsService,
    private readonly pauser: ApiCampaignPauser,
    private readonly platformEvents: PlatformEvents,
  ) {}

  async trigger(apiName: string, input: TriggerRequest, key: ApiKeyContext): Promise<Answer<TriggerAccepted>> {
    const campaign = await this.prisma.apiCampaign.findUnique({
      where: { apiName },
      include: { template: { select: { status: true, category: true, variables: true, components: true } }, number: { select: { connectionStatus: true, sendingEnabled: true } } },
    });
    if (!campaign) throw AppError.notFound('API campaign not found');
    const settings = await this.settings.get();
    const phone = normalizePhone(input.phone, settings.defaultCountryCode);
    /** Records the refused trigger and returns the answer to throw. */
    const refusal = async (reason: string, error: AppError, contactId: string | null = null): Promise<AppError> => {
      await this.record(campaign, key, { outcome: 'NOT_SENT', reason, contactId, phone: phone?.e164 ?? null, messageId: null });
      return error;
    };

    if (campaign.status !== 'LIVE') throw await refusal('not_live', notLive(campaign.status, campaign.pausedReason));
    // The last check of FR-021, for changes the webhooks did not report.
    const unavailable: SelfPauseReason | null =
      campaign.template.status !== 'APPROVED' ? 'TEMPLATE_UNAVAILABLE' : campaign.number.connectionStatus !== 'CONNECTED' ? 'NUMBER_DISCONNECTED' : null;
    if (unavailable) {
      await this.pauser.pause(campaign, unavailable);
      throw await refusal('not_live', notLive('PAUSED', unavailable));
    }
    if (!campaign.number.sendingEnabled) throw await refusal('number_unavailable', notSent('number_unavailable', "Sending is turned off for this campaign's number"));
    if (!phone) throw await refusal('invalid_phone', AppError.validation('Invalid phone number', [{ field: 'phone', issue: 'is not a valid phone number' }]));

    // The 001 sending rules: never blocked or opted-out contacts; marketing needs an opt-in.
    const existing = await this.prisma.contact.findUnique({
      where: { phoneE164: phone.e164 },
      select: { id: true, name: true, attributes: true, consentStatus: true, blockedAt: true },
    });
    const existingId = existing?.id ?? null;
    if (!existing && !campaign.createContacts) {
      throw await refusal('not_a_contact', notSent('not_a_contact', 'This campaign sends only to existing contacts, and this phone number is not one'));
    }
    if (existing?.blockedAt) throw await refusal('blocked', notSent('blocked', 'The contact is blocked'), existingId);
    if (existing?.consentStatus === 'OPTED_OUT') throw await refusal('opted_out', notSent('opted_out', 'The contact opted out'), existingId);
    if (campaign.template.category === 'MARKETING' && existing?.consentStatus !== 'OPTED_IN' && !input.optIn) {
      throw await refusal('no_opt_in', notSent('no_opt_in', 'Marketing templates need an opt-in: send optIn with a source note to record one'), existingId);
    }

    // Template values from the call, the contact or fixed text; attribute values from the call.
    const attributeValues = resolveAttributeValues(asRecord(campaign.attributes), input.values);
    const facts = {
      name: existing ? existing.name : (input.name ?? null),
      phone: phone.e164,
      attributes: { ...asRecord(existing?.attributes), ...attributeValues },
    };
    const resolved = resolveApiValues(templateVariableKeys(campaign.template), asRecord(campaign.variableMapping) as ApiVariableMapping, input.values, facts);
    if (!resolved.ok) throw await refusal('missing_value', missingValue(resolved), existingId);
    const params: Record<string, string> = { ...resolved.params };
    const mediaType = headerMediaType(campaign.template.components as unknown as MetaTemplateComponent[]);
    if (mediaType) {
      if (campaign.headerMediaAssetId) params[HEADER_MEDIA_ASSET_PARAM] = campaign.headerMediaAssetId;
      else if (input.mediaUrl) params[HEADER_MEDIA_URL_PARAM] = input.mediaUrl;
      else {
        const error = new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'MISSING_VALUE', `The template has a ${mediaType.toLowerCase()} header: send mediaUrl`, [{ field: 'mediaUrl', issue: 'is required' }], {
          reason: 'missing_value',
        });
        throw await refusal('missing_value', error, existingId);
      }
    }

    // The daily limit counts sent messages of the company's day (FR-020).
    const dayStart = startOfLocalDay(new Date(), settings.defaultTimezone);
    if (campaign.dailyLimit && (await this.sentSince(this.prisma, campaign.id, dayStart)) >= campaign.dailyLimit) {
      throw await refusal('daily_limit', dailyLimit(campaign.dailyLimit), existingId);
    }

    // The contact, with the dashboard's rules: created when new, the campaign's tags and attribute
    // values, and the opt-in with its source note.
    let contactId: string;
    try {
      const upsert = await this.contacts.upsert(
        {
          phone: phone.e164,
          ...(existing ? {} : { name: input.name ?? null }),
          ...(campaign.tags.length ? { tags: campaign.tags } : {}),
          ...(Object.keys(attributeValues).length ? { attributes: attributeValues } : {}),
          ...(input.optIn ? { optIn: input.optIn } : {}),
        },
        key,
      );
      contactId = upsert.body.id;
    } catch (error) {
      if (error instanceof AppError && error.status === HttpStatus.UNPROCESSABLE_ENTITY) throw await refusal('invalid_value', error, existingId);
      throw error;
    }

    const now = new Date();
    let messageId: string;
    try {
      messageId = await this.prisma.$transaction(async (tx) => {
        if (campaign.dailyLimit) {
          // One trigger at a time for a limited campaign, so parallel calls cannot pass the limit.
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${campaign.id}, 0))`;
          if ((await this.sentSince(tx, campaign.id, dayStart)) >= campaign.dailyLimit) throw new DailyLimitReached();
        }
        const message = await tx.message.create({
          data: {
            origin: 'API',
            apiKeyId: key.id,
            apiCampaignId: campaign.id,
            contactId,
            phoneE164: phone.e164,
            recipientCountry: phone.country,
            numberId: campaign.numberId,
            templateId: campaign.templateId,
            resolvedParams: params as Prisma.InputJsonValue,
            status: 'QUEUED',
            queuedAt: now,
          },
        });
        await tx.messageEvent.create({ data: { messageId: message.id, type: 'QUEUED', occurredAt: now, dedupeKey: `${message.id}:queued` } });
        await this.record(campaign, key, { outcome: 'QUEUED', reason: null, contactId, phone: phone.e164, messageId: message.id }, tx);
        return message.id;
      });
    } catch (error) {
      if (error instanceof DailyLimitReached && campaign.dailyLimit) throw await refusal('daily_limit', dailyLimit(campaign.dailyLimit), contactId);
      throw error;
    }

    try {
      await this.queues.sendQueue(campaign.numberId).add(
        'send',
        { messageId },
        { jobId: sendJobId(messageId), attempts: MAX_SEND_ATTEMPTS, backoff: { type: 'custom' }, removeOnComplete: true, removeOnFail: { age: 7 * 24 * 3600 } },
      );
    } catch (error) {
      // Not queued: the message is failed, and the caller's retry (same key) sends again.
      await this.prisma.message.update({ where: { id: messageId }, data: { status: 'FAILED', failureReason: 'queue_unavailable', failedAt: new Date() } });
      throw error;
    }
    return { status: 202, body: { messageId, contactId } };
  }

  private sentSince(db: Db, apiCampaignId: string, since: Date): Promise<number> {
    return db.apiCampaignTrigger.count({ where: { apiCampaignId, outcome: 'QUEUED', createdAt: { gte: since } } });
  }

  private async record(
    campaign: Campaign,
    key: ApiKeyContext,
    t: { outcome: 'QUEUED' | 'NOT_SENT'; reason: string | null; contactId: string | null; phone: string | null; messageId: string | null },
    db: Db = this.prisma,
  ): Promise<void> {
    await db.apiCampaignTrigger.create({
      data: { apiCampaignId: campaign.id, apiKeyId: key.id, contactId: t.contactId, phoneE164: t.phone, outcome: t.outcome, reason: t.reason, messageId: t.messageId },
    });
    // Outbound webhooks (feature 006, FR-002).
    await this.platformEvents.apiCampaignTriggered(db, {
      campaign: { id: campaign.id, name: campaign.name, apiName: campaign.apiName },
      contactId: t.contactId,
      outcome: t.outcome,
      reason: t.reason,
      messageId: t.messageId,
    });
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
