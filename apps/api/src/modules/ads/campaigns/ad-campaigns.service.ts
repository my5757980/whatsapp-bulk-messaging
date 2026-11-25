import { Inject, Injectable } from '@nestjs/common';
import {
  AD_GOALS,
  AD_SPECIAL_CATEGORIES,
  budgetProblem,
  formatMinor,
  mediaKindOf,
  normalizePlacements,
  placementProblems,
  targetingProblems,
  versionProblems,
  type AdGoal,
  type AdPlacements,
  type AdTargeting,
  type FieldProblem,
} from '@wbm/shared';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { AdCampaign, AdCampaignStatus, AdVersion, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { MetaApiError, MetaNetworkError } from '../../meta/meta-graph.client.js';
import { AdsConnectionService, type AdsAccess } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';
import { AdsCap, SPENDING_STATES } from '../sync/ads-cap.js';
import { ADS_FOLLOW_UP_DELAYS_MS, ADS_STATUS_ONE_JOB, type AdsStatusOneData } from '../sync/ads-jobs.js';
import { AdLauncher, adLinkUrl } from './ad-launcher.js';

// Ad campaigns (feature 007 US2 and US5, FR-005 – FR-020, FR-024, contracts/ads-api.openapi.yaml):
// drafts checked with the shared rules, the submit with Meta's minimum, the linked number and the cap,
// resubmitting edited rejected versions, and the changes allowed once a campaign is at Meta.

const Option = z.object({
  key: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  type: z.string().trim().min(1).max(40),
  countryCode: z.string().max(4).nullish(),
  audienceLower: z.number().int().nullish(),
  audienceUpper: z.number().int().nullish(),
});
export const TargetingSchema = z.object({
  locations: z.array(Option).min(1).max(50),
  ageMin: z.number().int().min(18).max(65).optional(),
  ageMax: z.number().int().min(18).max(65).optional(),
  genders: z.enum(['ALL', 'MEN', 'WOMEN']).optional(),
  interests: z.array(Option).max(25).optional(),
  includeAudienceIds: z.array(z.uuid()).max(10).optional(),
  excludeAudienceIds: z.array(z.uuid()).max(10).optional(),
});
export const PlacementsSchema = z.object({
  auto: z.boolean(),
  facebook: z.array(z.enum(['feed', 'story'])).optional(),
  instagram: z.array(z.enum(['stream', 'story'])).optional(),
  whatsappStatus: z.boolean().optional(),
});
export const VersionSchema = z
  .object({
    mediaAssetId: z.uuid(),
    primaryText: z.string().trim().min(1).max(2200),
    headline: z.string().trim().min(1).max(255),
    callToAction: z.enum(['WHATSAPP_MESSAGE', 'SIGN_UP', 'LEARN_MORE', 'SHOP_NOW', 'CONTACT_US']),
  })
  .strict();
const fields = {
  name: z.string().trim().min(1).max(120),
  numberId: z.uuid().nullish(),
  prefilledMessage: z.string().trim().max(300).nullish(),
  leadFormId: z.uuid().nullish(),
  websiteUrl: z
    .string()
    .trim()
    .max(2000)
    .regex(/^https:\/\//, 'must start with https://')
    .nullish(),
  targeting: TargetingSchema,
  placements: PlacementsSchema,
  specialCategory: z.enum(AD_SPECIAL_CATEGORIES).optional(),
  dailyBudgetMinor: z.number().int().min(1),
  startAt: z.iso.datetime({ offset: true }),
  endAt: z.iso.datetime({ offset: true }).nullish(),
  flowId: z.uuid().nullish(),
  tagId: z.uuid().nullish(),
  versions: z.array(VersionSchema).min(1).max(5),
};
export const CampaignInputSchema = z.object({ ...fields, goal: z.enum(AD_GOALS) }).strict();
export const CampaignPatchSchema = z
  .object(fields)
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'change at least one field' });
export const ListSchema = z.object({ status: z.enum(['DRAFT', 'SUBMITTING', 'IN_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'ENDED', 'ERROR']).optional() }).strict();

export type CampaignInput = z.infer<typeof CampaignInputSchema>;
export type CampaignPatch = z.infer<typeof CampaignPatchSchema>;
export type VersionInput = z.infer<typeof VersionSchema>;

type Row = AdCampaign & { versions: AdVersion[] };
interface Stats {
  spendMinor: number;
  chatsStarted: number;
  leads: number;
}

/** States of campaigns made at Meta in which budgets, dates, the flow and the tag can change. */
const AT_META: readonly AdCampaignStatus[] = ['IN_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'ERROR'];
/** Campaigns that can be paused: in review, active, or with a delivery problem. */
const RUNNING: readonly AdCampaignStatus[] = ['IN_REVIEW', 'ACTIVE', 'ERROR'];
const AFTER_SUBMIT_FIELDS = new Set(['dailyBudgetMinor', 'endAt', 'flowId', 'tagId']);

@Injectable()
export class AdCampaignsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connection: AdsConnectionService,
    private readonly ads: MetaAdsClient,
    private readonly launcher: AdLauncher,
    private readonly audit: AuditService,
    private readonly queues: QueueRegistry,
    private readonly cap: AdsCap,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async list(status?: AdCampaignStatus) {
    const rows = await this.prisma.adCampaign.findMany({ where: { deletedAt: null, ...(status ? { status } : {}) }, orderBy: { createdAt: 'desc' }, take: 500 });
    const stats = await this.stats(rows.map((r) => r.id));
    return rows.map((r) => this.summary(r, stats.get(r.id)));
  }

  async get(id: string) {
    const row = await this.find(id);
    const stats = await this.stats([id]);
    return this.dto(row, stats.get(id));
  }

  async create(input: CampaignInput, actor: AuditActor & { userId: string }) {
    const access = await this.connection.access();
    if (!access) throw AppError.conflict('Connect the ad account first (Ads > Connect)', 'NOT_CONNECTED');
    const placements = normalizePlacements(input.placements as AdPlacements);
    const problems = await this.problems({ ...input, placements, specialCategory: input.specialCategory ?? 'NONE' });
    if (problems.length) throw AppError.validation('Check the ad campaign', problems);
    const kinds = await this.mediaKinds(input.versions);
    let id: string;
    try {
      ({ id } = await this.prisma.adCampaign.create({
        data: {
          name: input.name,
          goal: input.goal,
          numberId: input.goal === 'CHATS' ? (input.numberId ?? null) : null,
          prefilledMessage: input.goal === 'CHATS' ? (input.prefilledMessage ?? null) : null,
          leadFormId: input.goal === 'LEADS' ? (input.leadFormId ?? null) : null,
          websiteUrl: input.goal === 'WEBSITE' ? (input.websiteUrl ?? null) : null,
          targeting: input.targeting as Prisma.InputJsonValue,
          placements: placements as unknown as Prisma.InputJsonValue,
          specialCategory: input.specialCategory ?? 'NONE',
          dailyBudgetMinor: BigInt(input.dailyBudgetMinor),
          currency: access.row.currency,
          startAt: new Date(input.startAt),
          endAt: input.endAt ? new Date(input.endAt) : null,
          flowId: input.flowId ?? null,
          tagId: input.tagId ?? null,
          createdById: actor.userId,
          versions: { create: input.versions.map((v, i) => ({ ...v, position: i + 1, mediaKind: kinds.get(v.mediaAssetId)! })) },
        },
        select: { id: true },
      }));
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('An ad campaign with this name exists', 'NAME_TAKEN');
      throw error;
    }
    await this.audit.record(actor, 'ad_campaign.created', { type: 'ad_campaign', id }, { name: input.name, goal: input.goal, versions: input.versions.length });
    return this.get(id);
  }

  async patch(id: string, input: CampaignPatch, actor: AuditActor) {
    const row = await this.find(id);
    if (this.isDraft(row)) return this.patchDraft(row, input);
    if (!AT_META.includes(row.status) || !row.metaCampaignId) throw AppError.conflict('This campaign cannot be changed now', 'NOT_EDITABLE');
    const refused = Object.keys(input).filter((k) => !AFTER_SUBMIT_FIELDS.has(k));
    if (refused.length) throw AppError.conflict(`Only the daily budget, end date, flow and tag change once a campaign is at Meta (not ${refused.join(', ')})`, 'NOT_EDITABLE');
    const problems = await this.referenceProblems({ goal: row.goal, numberId: row.numberId, flowId: input.flowId, tagId: input.tagId });
    const endAt = input.endAt === undefined ? row.endAt : input.endAt ? new Date(input.endAt) : null;
    if (endAt && endAt <= new Date()) problems.push({ field: 'endAt', issue: 'must be in the future' });
    if (problems.length) throw AppError.validation('Check the ad campaign', problems);

    const budgetChanged = input.dailyBudgetMinor !== undefined && BigInt(input.dailyBudgetMinor) !== row.dailyBudgetMinor;
    const endChanged = input.endAt !== undefined && (endAt?.getTime() ?? null) !== (row.endAt?.getTime() ?? null);
    if (budgetChanged || endChanged) {
      const access = await this.connection.requireUsable();
      if (budgetChanged) {
        const min = await this.meta(() => this.ads.minimumDailyBudget(access.token, access.row.adAccountId));
        const problem = budgetProblem(input.dailyBudgetMinor!, min.minDailyBudgetMinor);
        if (problem) throw AppError.validation('Check the daily budget', [{ field: 'dailyBudgetMinor', issue: `${problem} — ${formatMinor(min.minDailyBudgetMinor, row.currency)}` }]);
        if (input.dailyBudgetMinor! > Number(row.dailyBudgetMinor) && SPENDING_STATES.includes(row.status)) await this.cap.check(input.dailyBudgetMinor!, access, row.id);
      }
      await this.meta(() =>
        this.ads.update(access.token, row.metaAdsetId!, {
          ...(budgetChanged ? { daily_budget: input.dailyBudgetMinor } : {}),
          ...(endChanged ? { end_time: endAt ? endAt.toISOString() : 0 } : {}),
        }),
      );
      await this.audit.record(actor, 'ad_campaign.budget_changed', { type: 'ad_campaign', id }, {
        ...(budgetChanged ? { from: Number(row.dailyBudgetMinor), to: input.dailyBudgetMinor, currency: row.currency } : {}),
        ...(endChanged ? { endAt: endAt?.toISOString() ?? null } : {}),
      });
    }
    await this.prisma.adCampaign.update({
      where: { id },
      data: {
        ...(budgetChanged ? { dailyBudgetMinor: BigInt(input.dailyBudgetMinor!) } : {}),
        ...(input.endAt !== undefined ? { endAt } : {}),
        ...(input.flowId !== undefined ? { flowId: input.flowId } : {}),
        ...(input.tagId !== undefined ? { tagId: input.tagId } : {}),
      },
    });
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    const row = await this.find(id);
    if (!this.isDraft(row)) throw AppError.conflict('Only drafts can be deleted; end the campaign instead', 'NOT_A_DRAFT');
    await this.prisma.adCampaign.update({ where: { id }, data: { deletedAt: new Date() } });
  }

  /** Drafts change any version; submitted campaigns only their rejected versions, sent again on submit. */
  async updateVersion(id: string, versionId: string, input: VersionInput) {
    const row = await this.find(id);
    const version = row.versions.find((v) => v.id === versionId);
    if (!version) throw AppError.notFound('Version not found');
    const draft = this.isDraft(row);
    if (!draft && !(version.status === 'REJECTED' && row.metaCampaignId)) throw AppError.conflict('Only draft or rejected versions can be edited', 'NOT_EDITABLE');
    const problems = await this.versionsProblems(row.goal, [input], version.position - 1);
    if (problems.length) throw AppError.validation('Check the version', problems);
    const kinds = await this.mediaKinds([input]);
    const mediaChanged = input.mediaAssetId !== version.mediaAssetId;
    await this.prisma.adVersion.update({
      where: { id: versionId },
      data: {
        ...input,
        mediaKind: kinds.get(input.mediaAssetId)!,
        ...(mediaChanged ? { metaImageHash: null, metaVideoId: null } : {}),
        // A cleared creative marks the rejected version as edited: the next submit sends it again.
        ...(draft ? {} : { metaCreativeId: null }),
      },
    });
    return this.get(id);
  }

  async submit(id: string, actor: AuditActor) {
    const row = await this.find(id);
    const access = await this.connection.requireUsable();
    if (!this.isDraft(row)) return this.resubmit(row, access, actor);

    const problems = await this.problems({
      goal: row.goal,
      name: row.name,
      numberId: row.numberId,
      prefilledMessage: row.prefilledMessage,
      leadFormId: row.leadFormId,
      websiteUrl: row.websiteUrl,
      targeting: row.targeting as unknown as AdTargeting,
      placements: row.placements as unknown as AdPlacements,
      specialCategory: row.specialCategory,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt?.toISOString() ?? null,
      flowId: row.flowId,
      tagId: row.tagId,
      versions: row.versions.map((v) => ({ mediaAssetId: v.mediaAssetId, primaryText: v.primaryText, headline: v.headline, callToAction: v.callToAction })),
    } as Parameters<AdCampaignsService['problems']>[0]);
    const now = new Date();
    if (row.endAt && row.endAt <= now) problems.push({ field: 'endAt', issue: 'is in the past' });
    if (row.currency !== access.row.currency) problems.push({ field: 'dailyBudgetMinor', issue: `is in ${row.currency}, but the ad account now uses ${access.row.currency}` });
    const min = await this.meta(() => this.ads.minimumDailyBudget(access.token, access.row.adAccountId));
    const budget = budgetProblem(Number(row.dailyBudgetMinor), min.minDailyBudgetMinor);
    if (budget) problems.push({ field: 'dailyBudgetMinor', issue: `${budget} — ${formatMinor(min.minDailyBudgetMinor, access.row.currency)}` });
    if (row.goal === 'CHATS' && row.numberId) {
      const linked = ((access.row.checks ?? {}) as { linkedNumbers?: string[] | null }).linkedNumbers;
      const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: row.numberId }, select: { displayPhoneNumber: true } });
      const digits = (s: string) => s.replace(/\D/g, '');
      if (linked && number && !linked.some((l) => digits(l) === digits(number.displayPhoneNumber))) {
        problems.push({ field: 'numberId', issue: 'is not linked to the Facebook page in Meta (Page settings > Linked accounts)' });
      }
    }
    if (problems.length) throw AppError.validation('Fix these before submitting', problems);
    await this.cap.check(Number(row.dailyBudgetMinor), access, row.id);

    const locked = await this.prisma.adCampaign.updateMany({
      where: { id, status: { in: ['DRAFT', 'ERROR'] }, metaCampaignId: null, deletedAt: null },
      data: { status: 'SUBMITTING', lastError: null },
    });
    if (!locked.count) throw AppError.conflict('The campaign is being submitted already', 'NOT_SUBMITTABLE');
    try {
      await this.launcher.launch(id, access, now);
    } catch (error) {
      const message = errorText(error);
      await this.prisma.adCampaign.update({ where: { id }, data: { status: 'ERROR', lastError: message.slice(0, 500) } });
      if (error instanceof MetaApiError && error.code === 190) await this.connection.markError(`Meta stopped accepting the ads token: ${message}`);
      throw AppError.validation(`Meta refused the campaign: ${message}`, [], 'META_REFUSED');
    }
    await this.audit.record(actor, 'ad_campaign.submitted', { type: 'ad_campaign', id }, { versions: row.versions.length, dailyBudgetMinor: Number(row.dailyBudgetMinor), currency: row.currency });
    await this.followUp(id);
    return this.get(id);
  }

  // ---------- Managing running campaigns (US5, FR-016 – FR-019) ----------

  async pause(id: string, actor: AuditActor) {
    const row = await this.find(id);
    if (!RUNNING.includes(row.status) || !row.metaCampaignId) throw AppError.conflict('Only campaigns in review, active or with a problem can be paused', 'NOT_RUNNING');
    const access = await this.connection.requireUsable();
    await this.meta(() => this.ads.update(access.token, row.metaCampaignId!, { status: 'PAUSED' }));
    await this.prisma.adCampaign.update({ where: { id }, data: { status: 'PAUSED', metaStatus: 'PAUSED' } });
    await this.audit.record(actor, 'ad_campaign.paused', { type: 'ad_campaign', id }, {});
    return this.get(id);
  }

  async resume(id: string, actor: AuditActor) {
    const row = await this.find(id);
    if (row.status !== 'PAUSED' || !row.metaCampaignId) throw AppError.conflict('Only paused campaigns can be resumed', 'NOT_PAUSED');
    if (row.endAt && row.endAt <= new Date()) throw AppError.conflict('The campaign has ended; duplicate it to run it again', 'NOT_PAUSED');
    const access = await this.connection.requireUsable();
    await this.cap.check(Number(row.dailyBudgetMinor), access, row.id);
    await this.meta(() => this.ads.update(access.token, row.metaCampaignId!, { status: 'ACTIVE' }));
    const status = row.versions.some((v) => v.status === 'ACTIVE') || !row.versions.some((v) => v.status === 'IN_REVIEW') ? 'ACTIVE' : 'IN_REVIEW';
    await this.prisma.adCampaign.update({ where: { id }, data: { status, metaStatus: 'ACTIVE', lastError: null } });
    await this.audit.record(actor, 'ad_campaign.resumed', { type: 'ad_campaign', id }, {});
    await this.followUp(id);
    return this.get(id);
  }

  /** Ends now: the campaign pauses at Meta and its ad set ends; the platform keeps its results. */
  async end(id: string, actor: AuditActor, now = new Date()) {
    const row = await this.find(id);
    if (!AT_META.includes(row.status) || !row.metaCampaignId) throw AppError.conflict('Only campaigns at Meta can be ended', 'NOT_RUNNING');
    const access = await this.connection.requireUsable();
    await this.meta(() => this.ads.update(access.token, row.metaCampaignId!, { status: 'PAUSED' }));
    // Meta may refuse an end time in the past; the pause already stops delivery.
    if (row.metaAdsetId) await this.ads.update(access.token, row.metaAdsetId, { end_time: new Date(now.getTime() + 60_000).toISOString() }).catch(() => undefined);
    await this.prisma.$transaction([
      this.prisma.adCampaign.update({ where: { id }, data: { status: 'ENDED', metaStatus: 'PAUSED', endAt: now, endedAt: now } }),
      this.prisma.adVersion.updateMany({ where: { adCampaignId: id }, data: { status: 'ENDED' } }),
    ]);
    await this.audit.record(actor, 'ad_campaign.ended', { type: 'ad_campaign', id }, {});
    return this.get(id);
  }

  /** A new draft with the same settings and versions (never Meta's ids). */
  async duplicate(id: string, actor: AuditActor & { userId: string }) {
    const row = await this.find(id);
    const now = new Date();
    for (let n = 1; n <= 50; n += 1) {
      const name = `${row.name} (copy${n > 1 ? ` ${n}` : ''})`.slice(0, 120);
      try {
        const copy = await this.prisma.adCampaign.create({
          data: {
            name,
            goal: row.goal,
            numberId: row.numberId,
            prefilledMessage: row.prefilledMessage,
            leadFormId: row.leadFormId,
            websiteUrl: row.websiteUrl,
            targeting: row.targeting as Prisma.InputJsonValue,
            placements: row.placements as Prisma.InputJsonValue,
            specialCategory: row.specialCategory,
            dailyBudgetMinor: row.dailyBudgetMinor,
            currency: row.currency,
            startAt: row.startAt > now ? row.startAt : now,
            endAt: row.endAt && row.endAt > now ? row.endAt : null,
            flowId: row.flowId,
            tagId: row.tagId,
            createdById: actor.userId,
            versions: {
              create: row.versions.map((v) => ({ position: v.position, mediaAssetId: v.mediaAssetId, mediaKind: v.mediaKind, primaryText: v.primaryText, headline: v.headline, callToAction: v.callToAction })),
            },
          },
          select: { id: true },
        });
        await this.audit.record(actor, 'ad_campaign.duplicated', { type: 'ad_campaign', id: copy.id }, { from: id });
        return this.get(copy.id);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
    }
    throw AppError.conflict('Rename some copies first', 'NAME_TAKEN');
  }

  async pauseVersion(id: string, versionId: string, actor: AuditActor) {
    const { row, version, access } = await this.versionAtMeta(id, versionId);
    if (version.status !== 'ACTIVE' && version.status !== 'IN_REVIEW') throw AppError.conflict('Only versions in review or active can be paused', 'NOT_RUNNING');
    await this.meta(() => this.ads.update(access.token, version.metaAdId!, { status: 'PAUSED' }));
    await this.prisma.adVersion.update({ where: { id: versionId }, data: { status: 'PAUSED' } });
    // With every version paused or rejected, the campaign shows as paused.
    if (row.versions.every((v) => v.id === versionId || v.status === 'PAUSED' || v.status === 'REJECTED')) await this.prisma.adCampaign.update({ where: { id }, data: { status: 'PAUSED' } });
    await this.audit.record(actor, 'ad_campaign.paused', { type: 'ad_campaign', id }, { versionId, position: version.position });
    return this.get(id);
  }

  async resumeVersion(id: string, versionId: string, actor: AuditActor) {
    const { row, version, access } = await this.versionAtMeta(id, versionId);
    if (version.status !== 'PAUSED') throw AppError.conflict('Only paused versions can be resumed', 'NOT_PAUSED');
    if (row.status === 'PAUSED' && row.metaStatus === 'PAUSED') throw AppError.conflict('Resume the campaign first', 'NOT_PAUSED');
    await this.meta(() => this.ads.update(access.token, version.metaAdId!, { status: 'ACTIVE' }));
    await this.prisma.adVersion.update({ where: { id: versionId }, data: { status: 'ACTIVE' } });
    if (row.status === 'PAUSED') await this.prisma.adCampaign.update({ where: { id }, data: { status: 'ACTIVE' } });
    await this.audit.record(actor, 'ad_campaign.resumed', { type: 'ad_campaign', id }, { versionId, position: version.position });
    await this.followUp(id);
    return this.get(id);
  }

  private async versionAtMeta(id: string, versionId: string) {
    const row = await this.find(id);
    const version = row.versions.find((v) => v.id === versionId);
    if (!version) throw AppError.notFound('Version not found');
    if (!row.metaCampaignId || !version.metaAdId || row.status === 'ENDED') throw AppError.conflict('This version is not running at Meta', 'NOT_RUNNING');
    const access = await this.connection.requireUsable();
    return { row, version, access };
  }

  /** Reads Meta's state again shortly after a submit, until the review ends. */
  async followUp(campaignId: string): Promise<void> {
    const data: AdsStatusOneData = { campaignId, attempt: 0 };
    await this.queues
      .get(QUEUES.ADS)
      .add(ADS_STATUS_ONE_JOB, data, { delay: ADS_FOLLOW_UP_DELAYS_MS[0], jobId: `ads-status-${campaignId}-${Date.now()}`, attempts: 1, removeOnComplete: true, removeOnFail: 20 });
  }

  async find(id: string): Promise<Row> {
    const row = await this.prisma.adCampaign.findFirst({ where: { id, deletedAt: null }, include: { versions: { orderBy: { position: 'asc' } } } });
    if (!row) throw AppError.notFound('Ad campaign not found');
    return row;
  }

  /** Not made at Meta (yet, or any more after a failed submit). */
  isDraft(row: AdCampaign): boolean {
    return (row.status === 'DRAFT' || row.status === 'ERROR') && !row.metaCampaignId;
  }

  dto(row: Row, stats?: Stats) {
    return {
      ...this.summary(row, stats),
      numberId: row.numberId,
      prefilledMessage: row.prefilledMessage,
      leadFormId: row.leadFormId,
      websiteUrl: row.websiteUrl,
      linkUrl: adLinkUrl(this.config.PUBLIC_LINK_BASE_URL, row.linkCode),
      targeting: row.targeting as unknown as AdTargeting,
      placements: row.placements as unknown as AdPlacements,
      specialCategory: row.specialCategory,
      flowId: row.flowId,
      tagId: row.tagId,
      lastError: row.lastError,
      syncedAt: row.syncedAt?.toISOString() ?? null,
      versions: row.versions.map((v) => ({
        id: v.id,
        position: v.position,
        mediaAssetId: v.mediaAssetId,
        mediaKind: v.mediaKind,
        primaryText: v.primaryText,
        headline: v.headline,
        callToAction: v.callToAction,
        status: v.status,
        reviewFeedback: v.reviewFeedback,
        metaAdId: v.metaAdId,
        edited: v.status === 'REJECTED' && !v.metaCreativeId && Boolean(v.metaAdId),
      })),
    };
  }

  private async patchDraft(row: Row, input: CampaignPatch) {
    const merged = {
      goal: row.goal,
      name: input.name ?? row.name,
      numberId: input.numberId === undefined ? row.numberId : input.numberId,
      prefilledMessage: input.prefilledMessage === undefined ? row.prefilledMessage : input.prefilledMessage,
      leadFormId: input.leadFormId === undefined ? row.leadFormId : input.leadFormId,
      websiteUrl: input.websiteUrl === undefined ? row.websiteUrl : input.websiteUrl,
      targeting: (input.targeting ?? row.targeting) as AdTargeting,
      placements: normalizePlacements((input.placements ?? row.placements) as AdPlacements),
      specialCategory: input.specialCategory ?? row.specialCategory,
      startAt: input.startAt ?? row.startAt.toISOString(),
      endAt: input.endAt === undefined ? (row.endAt?.toISOString() ?? null) : input.endAt,
      flowId: input.flowId === undefined ? row.flowId : input.flowId,
      tagId: input.tagId === undefined ? row.tagId : input.tagId,
      versions: input.versions ?? row.versions.map((v) => ({ mediaAssetId: v.mediaAssetId, primaryText: v.primaryText, headline: v.headline, callToAction: v.callToAction as VersionInput['callToAction'] })),
      dailyBudgetMinor: input.dailyBudgetMinor ?? Number(row.dailyBudgetMinor),
    };
    const problems = await this.problems(merged);
    if (problems.length) throw AppError.validation('Check the ad campaign', problems);
    const kinds = input.versions ? await this.mediaKinds(input.versions) : null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.adCampaign.update({
          where: { id: row.id },
          data: {
            name: merged.name,
            numberId: merged.numberId ?? null,
            prefilledMessage: merged.prefilledMessage ?? null,
            leadFormId: merged.leadFormId ?? null,
            websiteUrl: merged.websiteUrl ?? null,
            targeting: merged.targeting as unknown as Prisma.InputJsonValue,
            placements: merged.placements as unknown as Prisma.InputJsonValue,
            specialCategory: merged.specialCategory,
            dailyBudgetMinor: BigInt(merged.dailyBudgetMinor),
            startAt: new Date(merged.startAt),
            endAt: merged.endAt ? new Date(merged.endAt) : null,
            flowId: merged.flowId ?? null,
            tagId: merged.tagId ?? null,
            // A changed message needs a new welcome message sequence at the next submit.
            ...(input.prefilledMessage !== undefined && input.prefilledMessage !== row.prefilledMessage ? { welcomeSequenceId: null } : {}),
          },
        });
        if (input.versions && kinds) {
          await tx.adVersion.deleteMany({ where: { adCampaignId: row.id } });
          await tx.adVersion.createMany({ data: input.versions.map((v, i) => ({ ...v, adCampaignId: row.id, position: i + 1, mediaKind: kinds.get(v.mediaAssetId)! })) });
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('An ad campaign with this name exists', 'NAME_TAKEN');
      throw error;
    }
    return this.get(row.id);
  }

  private async resubmit(row: Row, access: AdsAccess, actor: AuditActor) {
    const edited = row.versions.filter((v) => v.status === 'REJECTED' && !v.metaCreativeId && v.metaAdId);
    if (!AT_META.includes(row.status) || !edited.length) throw AppError.conflict('Nothing to submit: edit a rejected version first', 'NOT_SUBMITTABLE');
    const problems = await this.versionsProblems(
      row.goal,
      edited.map((v) => ({ mediaAssetId: v.mediaAssetId, primaryText: v.primaryText, headline: v.headline, callToAction: v.callToAction as VersionInput['callToAction'] })),
    );
    if (problems.length) throw AppError.validation('Fix these before submitting', problems);
    let count: number;
    try {
      count = await this.launcher.resubmit(row.id, access);
    } catch (error) {
      throw AppError.validation(`Meta refused the version: ${errorText(error)}`, [], 'META_REFUSED');
    }
    if (row.status === 'REJECTED') await this.prisma.adCampaign.update({ where: { id: row.id }, data: { status: 'IN_REVIEW' } });
    await this.audit.record(actor, 'ad_campaign.submitted', { type: 'ad_campaign', id: row.id }, { resubmittedVersions: count });
    await this.followUp(row.id);
    return this.get(row.id);
  }

  private async problems(input: {
    goal: AdGoal;
    name?: string;
    numberId?: string | null;
    prefilledMessage?: string | null;
    leadFormId?: string | null;
    websiteUrl?: string | null;
    targeting: AdTargeting;
    placements: AdPlacements;
    specialCategory: (typeof AD_SPECIAL_CATEGORIES)[number];
    startAt: string;
    endAt?: string | null;
    flowId?: string | null;
    tagId?: string | null;
    versions: VersionInput[];
  }): Promise<FieldProblem[]> {
    const problems: FieldProblem[] = [...targetingProblems(input.targeting, input.specialCategory), ...placementProblems(input.placements, input.goal)];
    if (input.goal === 'CHATS') {
      if (!input.numberId) problems.push({ field: 'numberId', issue: 'is needed for chat ads' });
      if (!input.prefilledMessage?.trim()) problems.push({ field: 'prefilledMessage', issue: 'is needed for chat ads' });
    }
    if (input.goal === 'LEADS' && !input.leadFormId) problems.push({ field: 'leadFormId', issue: 'is needed for lead ads' });
    if (input.goal === 'WEBSITE' && !input.websiteUrl) problems.push({ field: 'websiteUrl', issue: 'is needed for website ads' });
    if (input.endAt && new Date(input.endAt) <= new Date(input.startAt)) problems.push({ field: 'endAt', issue: 'must be after the start' });
    problems.push(...(await this.versionsProblems(input.goal, input.versions)));
    problems.push(...(await this.referenceProblems(input)));
    const audienceIds = [...(input.targeting.includeAudienceIds ?? []), ...(input.targeting.excludeAudienceIds ?? [])];
    if (audienceIds.length) {
      const found = await this.prisma.adAudience.findMany({ where: { id: { in: audienceIds }, deletedAt: null }, select: { id: true, status: true } });
      for (const id of audienceIds) {
        const audience = found.find((a) => a.id === id);
        if (!audience) problems.push({ field: 'targeting.audiences', issue: `includes an audience that does not exist (${id})` });
        else if (audience.status !== 'READY') problems.push({ field: 'targeting.audiences', issue: 'includes an audience that is not ready' });
      }
    }
    return problems;
  }

  private async referenceProblems(input: { goal: AdGoal; numberId?: string | null; leadFormId?: string | null; flowId?: string | null; tagId?: string | null }): Promise<FieldProblem[]> {
    const problems: FieldProblem[] = [];
    if (input.goal === 'CHATS' && input.numberId) {
      const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: input.numberId }, select: { connectionStatus: true } });
      if (!number) problems.push({ field: 'numberId', issue: 'is not a WhatsApp number of the company' });
      else if (number.connectionStatus === 'DISCONNECTED') problems.push({ field: 'numberId', issue: 'is disconnected' });
    }
    if (input.goal === 'LEADS' && input.leadFormId) {
      const form = await this.prisma.adLeadForm.findUnique({ where: { id: input.leadFormId }, select: { id: true } });
      if (!form) problems.push({ field: 'leadFormId', issue: 'is not a lead form' });
    }
    if (input.flowId) {
      const flow = await this.prisma.flow.findUnique({
        where: { id: input.flowId },
        select: { status: true, deletedAt: true, publishedVersionId: true, allNumbers: true, numbers: input.numberId ? { where: { numberId: input.numberId }, select: { numberId: true } } : false },
      });
      if (!flow || flow.deletedAt) problems.push({ field: 'flowId', issue: 'is not a flow' });
      else if (flow.status !== 'PUBLISHED' || !flow.publishedVersionId) problems.push({ field: 'flowId', issue: 'is not published' });
      else if (input.numberId && !flow.allNumbers && !(flow.numbers as Array<{ numberId: string }> | undefined)?.length) problems.push({ field: 'flowId', issue: "does not run on the campaign's number" });
    }
    if (input.tagId && !(await this.prisma.tag.findUnique({ where: { id: input.tagId }, select: { id: true } }))) problems.push({ field: 'tagId', issue: 'is not a tag' });
    return problems;
  }

  private async versionsProblems(goal: AdGoal, versions: VersionInput[], offset = 0): Promise<FieldProblem[]> {
    const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: versions.map((v) => v.mediaAssetId) } }, select: { id: true, mimeType: true, sizeBytes: true, removedAt: true } });
    const problems: FieldProblem[] = [];
    versions.forEach((v, i) => {
      const at = `versions[${i + offset}]`;
      const asset = assets.find((a) => a.id === v.mediaAssetId);
      if (!asset || asset.removedAt) {
        problems.push({ field: `${at}.mediaAssetId`, issue: 'is not in the media library' });
        return;
      }
      for (const p of versionProblems({ ...v, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes }, goal)) problems.push({ field: `${at}.${p.field}`, issue: p.issue });
    });
    return problems;
  }

  private async mediaKinds(versions: VersionInput[]): Promise<Map<string, 'IMAGE' | 'VIDEO'>> {
    const assets = await this.prisma.mediaAsset.findMany({ where: { id: { in: versions.map((v) => v.mediaAssetId) } }, select: { id: true, mimeType: true } });
    return new Map(assets.map((a) => [a.id, mediaKindOf(a.mimeType) ?? 'IMAGE']));
  }

  private summary(row: AdCampaign, stats?: Stats) {
    return {
      id: row.id,
      name: row.name,
      goal: row.goal,
      status: row.status,
      dailyBudgetMinor: Number(row.dailyBudgetMinor),
      currency: row.currency,
      startAt: row.startAt.toISOString(),
      endAt: row.endAt?.toISOString() ?? null,
      spendMinor: stats?.spendMinor ?? 0,
      chatsStarted: stats?.chatsStarted ?? 0,
      leads: stats?.leads ?? 0,
    };
  }

  private async stats(ids: string[]): Promise<Map<string, Stats>> {
    const out = new Map<string, Stats>(ids.map((id) => [id, { spendMinor: 0, chatsStarted: 0, leads: 0 }]));
    if (!ids.length) return out;
    const [spend, chats, leads] = await Promise.all([
      this.prisma.adResultDay.groupBy({ by: ['adCampaignId'], where: { adCampaignId: { in: ids }, adVersionId: null }, _sum: { spendMinor: true } }),
      this.prisma.adChatStart.groupBy({ by: ['adCampaignId'], where: { adCampaignId: { in: ids } }, _count: { _all: true } }),
      this.prisma.adLead.groupBy({ by: ['adCampaignId'], where: { adCampaignId: { in: ids } }, _count: { _all: true } }),
    ]);
    for (const s of spend) out.get(s.adCampaignId)!.spendMinor = Number(s._sum.spendMinor ?? 0);
    for (const c of chats) if (c.adCampaignId) out.get(c.adCampaignId)!.chatsStarted = c._count._all;
    for (const l of leads) if (l.adCampaignId) out.get(l.adCampaignId)!.leads = l._count._all;
    return out;
  }

  /** Meta's refusals as 422 with its message; network failures as 503 (try again). */
  private async meta<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof MetaApiError) {
        if (error.code === 190) await this.connection.markError(`Meta stopped accepting the ads token: ${error.message}`);
        throw AppError.validation(`Meta refused: ${error.message}`, [], 'META_REFUSED');
      }
      if (error instanceof MetaNetworkError) throw new AppError(503, 'META_UNAVAILABLE', 'Meta did not answer; try again in a minute');
      throw error;
    }
  }
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
