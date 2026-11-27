import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { microsToUsd } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { PageQuery } from '../../common/validation/pagination.js';
import { Prisma, type Campaign } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { AudienceFilterSchema, AudienceQueryBuilder } from '../contacts/audience-query.builder.js';
import { describeMetaError } from '../meta/meta-error-classifier.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { toImportJobDto } from './imports.js';
import { CampaignPaymentConfigSchema } from './campaign-payments.port.js';
import { VariableMappingSchema } from './variable-resolver.js';

// Draft campaign CRUD, totals and auto-pause (T091).

export const CampaignInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    numberId: z.uuid().nullable(),
    templateId: z.uuid().nullable(),
    audienceType: z.enum(['FILTER', 'ALL_OPTED_IN', 'UPLOAD']),
    audienceFilter: AudienceFilterSchema.nullable(),
    variableMapping: VariableMappingSchema,
    headerMediaAssetId: z.uuid().nullable(),
    /** Feature 008: ask every recipient to pay (null: no payment). */
    paymentConfig: CampaignPaymentConfigSchema.nullable(),
    /** Feature 009 (research R6): carousel card files; cards not listed use the template's samples. */
    cardMedia: z.array(z.object({ cardIndex: z.number().int().min(0).max(9), mediaAssetId: z.uuid() }).strict()).max(10).nullable(),
    /** Feature 009 (research R7): a limited-time offer's end and where each recipient's code comes from. */
    offerConfig: z
      .object({
        endsAt: z.iso.datetime({ offset: true }),
        code: z.object({ source: z.enum(['static', 'column', 'attribute']), value: z.string().trim().max(15).optional(), key: z.string().trim().max(100).optional() }).strict(),
      })
      .strict()
      .nullable(),
    /** Feature 009 (research R10): one message per upload row, even when a number repeats. */
    allowDuplicateRows: z.boolean(),
  })
  .partial()
  .strict();
export type CampaignInput = z.infer<typeof CampaignInputSchema>;

export const CreateCampaignSchema = CampaignInputSchema.required({ name: true });

export const CampaignListQuerySchema = z.object({
  state: z.enum(['DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED']).optional(),
});

export interface StatusTotals {
  pending: number;
  queued: number;
  sent: number;
  delivered: number;
  read: number;
  failed: number;
  skipped: number;
  cancelled: number;
  /** Feature 009: not sent or not delivered in time, or after the offer ended. */
  expired: number;
}

export function emptyTotals(): StatusTotals {
  return { pending: 0, queued: 0, sent: 0, delivered: 0, read: 0, failed: 0, skipped: 0, cancelled: 0, expired: 0 };
}

function normaliseTotals(value: unknown): StatusTotals {
  const totals = emptyTotals();
  if (value && typeof value === 'object') {
    for (const key of Object.keys(totals) as Array<keyof StatusTotals>) {
      const n = (value as Record<string, unknown>)[key];
      if (typeof n === 'number') totals[key] = n;
    }
  }
  return totals;
}

const PAUSE_REASONS: Record<string, string> = {
  manual: 'paused by a user',
  sending_disabled: 'sending is turned off for the WhatsApp number',
  number_unavailable: 'the WhatsApp number is not connected',
  number_disconnected: 'the WhatsApp number was disconnected',
  template_paused: 'Meta paused the template',
  template_disabled: 'Meta disabled the template',
};

/** Readable explanation of `campaigns.paused_reason`. */
export function describePauseReason(reason: string): string {
  const meta = /^meta_error_(\d+)$/.exec(reason);
  if (meta) return describeMetaError(Number(meta[1]));
  return PAUSE_REASONS[reason] ?? reason;
}

type CampaignWithRefs = Campaign & {
  template?: { name: string } | null;
  number?: { label: string } | null;
  createdBy?: { name: string } | null;
};

const iso = (d: Date | null) => d?.toISOString() ?? null;

export function toCampaignDto(c: CampaignWithRefs, totals?: StatusTotals) {
  return {
    id: c.id,
    name: c.name,
    ...(c.numberId ? { numberId: c.numberId } : {}),
    ...(c.templateId ? { templateId: c.templateId } : {}),
    audienceType: c.audienceType as 'FILTER' | 'ALL_OPTED_IN' | 'UPLOAD',
    ...(c.audienceFilter ? { audienceFilter: c.audienceFilter } : {}),
    variableMapping: c.variableMapping ?? {},
    headerMediaAssetId: c.headerMediaAssetId,
    paymentConfig: c.paymentConfig ?? null,
    cardMedia: c.cardMedia ?? null,
    offerConfig: c.offerConfig ?? null,
    allowDuplicateRows: c.allowDuplicateRows,
    state: c.state,
    scheduledAt: iso(c.scheduledAt),
    timezone: c.timezone,
    pausedReason: c.pausedReason,
    pausedReasonText: c.pausedReason ? describePauseReason(c.pausedReason) : null,
    sourceCampaignId: c.sourceCampaignId,
    retargetStatus: c.retargetStatus,
    launchedAt: iso(c.launchedAt),
    completedAt: iso(c.completedAt),
    cancelledAt: iso(c.cancelledAt),
    totals: totals ?? normaliseTotals(c.totals),
    estimatedCostUsd: microsToUsd(c.estimatedCostUsdMicros),
    templateName: c.template?.name ?? null,
    numberLabel: c.number?.label ?? null,
    createdByName: c.createdBy?.name ?? null,
    createdAt: c.createdAt.toISOString(),
  };
}

const REFS = { template: { select: { name: true } }, number: { select: { label: true } }, createdBy: { select: { name: true } } } as const;

@Injectable()
export class CampaignsService {
  private readonly logger = new Logger(CampaignsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly audience: AudienceQueryBuilder,
  ) {}

  async getRow(id: string): Promise<Campaign> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    return campaign;
  }

  /** Live counts per status, read from the (campaign_id, status) index. */
  async computeTotals(campaignId: string): Promise<StatusTotals> {
    const rows = await this.prisma.message.groupBy({ by: ['status'], where: { campaignId }, _count: { _all: true } });
    const totals = emptyTotals();
    for (const row of rows) {
      const n = row._count._all;
      switch (row.status) {
        case 'PENDING':
          totals.pending += n;
          break;
        case 'QUEUED':
        case 'SENDING':
          totals.queued += n;
          break;
        case 'SENT':
          totals.sent += n;
          break;
        case 'DELIVERED':
          totals.delivered += n;
          break;
        case 'READ':
          totals.read += n;
          break;
        case 'FAILED':
          totals.failed += n;
          break;
        case 'SKIPPED':
          totals.skipped += n;
          break;
        case 'CANCELLED':
          totals.cancelled += n;
          break;
        case 'EXPIRED':
          totals.expired += n;
          break;
      }
    }
    return totals;
  }

  /** Detail view: live totals plus the latest audience upload (columns feed variable mapping). */
  async get(id: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id }, include: REFS });
    if (!campaign) throw AppError.notFound('Campaign not found');
    const upload = await this.prisma.importJob.findFirst({ where: { campaignId: id, kind: 'CAMPAIGN_AUDIENCE' }, orderBy: { createdAt: 'desc' } });
    return {
      ...toCampaignDto(campaign, campaign.state === 'DRAFT' ? emptyTotals() : await this.computeTotals(id)),
      audienceUpload: upload ? toImportJobDto(upload) : null,
    };
  }

  async list(query: PageQuery & { state?: Campaign['state'] }) {
    const where: Prisma.CampaignWhereInput = query.state ? { state: query.state } : {};
    const [items, total] = await Promise.all([
      this.prisma.campaign.findMany({
        where,
        include: REFS,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.campaign.count({ where }),
    ]);
    return { items: items.map((c) => toCampaignDto(c)), page: { page: query.page, pageSize: query.pageSize, total } };
  }

  private async assertRefs(input: CampaignInput): Promise<void> {
    const details = [];
    if (input.numberId && !(await this.prisma.whatsAppNumber.findUnique({ where: { id: input.numberId }, select: { id: true } }))) {
      details.push({ field: 'numberId', issue: 'WhatsApp number not found' });
    }
    if (input.templateId && !(await this.prisma.template.findUnique({ where: { id: input.templateId }, select: { id: true } }))) {
      details.push({ field: 'templateId', issue: 'Template not found' });
    }
    if (
      input.headerMediaAssetId &&
      !(await this.prisma.mediaAsset.findUnique({ where: { id: input.headerMediaAssetId }, select: { id: true } }))
    ) {
      details.push({ field: 'headerMediaAssetId', issue: 'Media not found' });
    }
    const pay = input.paymentConfig;
    if (pay?.tagId && !(await this.prisma.tag.findUnique({ where: { id: pay.tagId }, select: { id: true } }))) details.push({ field: 'paymentConfig.tagId', issue: 'Tag not found' });
    if (pay?.flowId && !(await this.prisma.flow.findFirst({ where: { id: pay.flowId, deletedAt: null }, select: { id: true } }))) details.push({ field: 'paymentConfig.flowId', issue: 'Flow not found' });
    for (const card of input.cardMedia ?? []) {
      if (!(await this.prisma.mediaAsset.findUnique({ where: { id: card.mediaAssetId }, select: { id: true } }))) details.push({ field: `cardMedia.${card.cardIndex}`, issue: 'Media not found' });
    }
    const offer = input.offerConfig;
    if (offer && offer.code.source === 'static' ? !offer.code.value : offer ? !offer.code.key : false) details.push({ field: 'offerConfig.code', issue: 'give the code, or the column or attribute it comes from' });
    if (details.length) throw AppError.validation('Request failed validation', details);
    if (input.audienceFilter) await this.audience.compile(input.audienceFilter);
  }

  private data(input: CampaignInput) {
    return {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.numberId !== undefined ? { numberId: input.numberId } : {}),
      ...(input.templateId !== undefined ? { templateId: input.templateId } : {}),
      ...(input.audienceType !== undefined ? { audienceType: input.audienceType } : {}),
      ...(input.audienceFilter !== undefined ? { audienceFilter: (input.audienceFilter ?? undefined) as Prisma.InputJsonValue | undefined } : {}),
      ...(input.variableMapping !== undefined ? { variableMapping: input.variableMapping as Prisma.InputJsonValue } : {}),
      ...(input.headerMediaAssetId !== undefined ? { headerMediaAssetId: input.headerMediaAssetId } : {}),
      ...(input.paymentConfig !== undefined ? { paymentConfig: input.paymentConfig === null ? Prisma.DbNull : (input.paymentConfig as Prisma.InputJsonValue) } : {}),
      ...(input.cardMedia !== undefined ? { cardMedia: input.cardMedia === null ? Prisma.DbNull : (input.cardMedia as Prisma.InputJsonValue) } : {}),
      ...(input.offerConfig !== undefined ? { offerConfig: input.offerConfig === null ? Prisma.DbNull : (input.offerConfig as Prisma.InputJsonValue) } : {}),
      ...(input.allowDuplicateRows !== undefined ? { allowDuplicateRows: input.allowDuplicateRows } : {}),
    };
  }

  async create(input: CampaignInput & { name: string }, userId: string) {
    await this.assertRefs(input);
    const campaign = await this.prisma.campaign.create({
      data: { ...this.data(input), name: input.name, audienceType: input.audienceType ?? 'UPLOAD', createdById: userId },
      include: REFS,
    });
    return toCampaignDto(campaign, emptyTotals());
  }

  async update(id: string, input: CampaignInput) {
    const campaign = await this.getRow(id);
    if (campaign.state !== 'DRAFT') throw AppError.conflict('Only draft campaigns can be edited');
    await this.assertRefs(input);
    const updated = await this.prisma.campaign.update({ where: { id }, data: this.data(input), include: REFS });
    return toCampaignDto(updated, emptyTotals());
  }

  async remove(id: string): Promise<void> {
    const { count } = await this.prisma.campaign.deleteMany({ where: { id, state: 'DRAFT' } });
    if (!count) {
      await this.getRow(id);
      throw AppError.conflict('Only draft campaigns can be deleted');
    }
  }

  /**
   * RUNNING -> PAUSED for a blocking condition (FR-027): buffered messages return to PENDING,
   * admins are notified and the action is audited. Returns false when the campaign was not running.
   */
  async autoPause(campaignId: string, reason: string, actor: AuditActor = {}): Promise<boolean> {
    const { count } = await this.prisma.campaign.updateMany({
      where: { id: campaignId, state: 'RUNNING' },
      data: { state: 'PAUSED', pausedReason: reason },
    });
    if (!count) return false;
    await this.prisma.message.updateMany({ where: { campaignId, status: 'QUEUED' }, data: { status: 'PENDING' } });
    const campaign = await this.getRow(campaignId);
    await this.notifications.notifyAdmins({
      type: 'CAMPAIGN_AUTO_PAUSED',
      title: 'Campaign paused automatically',
      body: `"${campaign.name}" was paused because ${describePauseReason(reason)}.`,
      link: `/campaigns/${campaignId}`,
    });
    await this.audit.record(actor, 'campaign.auto_paused', { type: 'campaign', id: campaignId }, { reason });
    this.logger.warn({ campaignId, reason }, 'Campaign auto-paused');
    return true;
  }
}
