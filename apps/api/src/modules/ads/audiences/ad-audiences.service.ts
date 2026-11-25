import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { AUDIENCE_BATCH, AUDIENCE_MIN_SIZE, normalizePhoneForHash } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { Prisma, type AdAudience } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { RETARGET_GROUPS, retargetCondition, type RetargetGroup } from '../../campaigns/retarget.service.js';
import { AudienceFilterSchema, AudienceQueryBuilder, type AudienceFilter } from '../../contacts/audience-query.builder.js';
import { MetaApiError } from '../../meta/meta-graph.client.js';
import { AdsConnectionService, type AdsAccess } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';
import { ADS_AUDIENCE_SYNC_JOB, type AdsAudienceSyncData } from '../sync/ads-jobs.js';

// Saved audiences (feature 007 US6, FR-031 – FR-034, research R8): contacts from a tag, a contact
// filter or a 005 campaign group, sent to Meta as SHA-256 hashes of their normalized phone numbers
// (opted-out and blocked contacts left out), kept up to date with daily differences, and lookalikes.

const SourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('tag'), tagId: z.uuid() }).strict(),
  z.object({ type: z.literal('filter'), filter: AudienceFilterSchema }).strict(),
  z.object({ type: z.literal('campaign_group'), campaignId: z.uuid(), group: z.enum(RETARGET_GROUPS) }).strict(),
]);
export const AudienceInputSchema = z.object({ name: z.string().trim().min(1).max(80), source: SourceSchema }).strict();
export const LookalikeSchema = z
  .object({ country: z.string().regex(/^[A-Z]{2}$/, 'must be a two-letter country code'), ratio: z.number().min(0.01).max(0.1), name: z.string().trim().min(1).max(80).optional() })
  .strict();
export type AudienceInput = z.infer<typeof AudienceInputSchema>;
export type AudienceSource = z.infer<typeof SourceSchema>;

/** SHA-256 in lowercase hex of the normalized number, as Meta's PHONE_SHA256 schema asks (R8). */
export function phoneHash(phoneE164: string): string | null {
  const normalized = normalizePhoneForHash(phoneE164);
  return normalized ? createHash('sha256').update(normalized).digest('hex') : null;
}

@Injectable()
export class AdAudiencesService {
  private readonly logger = new Logger(AdAudiencesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connection: AdsConnectionService,
    private readonly ads: MetaAdsClient,
    private readonly audiences: AudienceQueryBuilder,
    private readonly audit: AuditService,
    private readonly queues: QueueRegistry,
  ) {}

  async list() {
    const rows = await this.prisma.adAudience.findMany({ where: { deletedAt: null }, orderBy: { createdAt: 'desc' }, take: 500 });
    return rows.map((r) => this.dto(r));
  }

  async get(id: string) {
    return this.dto(await this.find(id));
  }

  async create(input: AudienceInput, actor: AuditActor & { userId: string }) {
    const access = await this.usable();
    await this.checkSource(input.source);
    let row: AdAudience;
    try {
      row = await this.prisma.adAudience.create({
        data: { name: input.name, kind: 'CUSTOM', source: input.source as Prisma.InputJsonValue, status: 'SYNCING', createdById: actor.userId },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('An audience with this name exists', 'NAME_TAKEN');
      throw error;
    }
    try {
      const metaAudienceId = await this.ads.createCustomAudience(access.token, access.row.adAccountId, input.name);
      row = await this.prisma.adAudience.update({ where: { id: row.id }, data: { metaAudienceId } });
    } catch (error) {
      await this.prisma.adAudience.delete({ where: { id: row.id } });
      throw this.refused(error);
    }
    await this.audit.record(actor, 'ad_audience.created', { type: 'ad_audience', id: row.id }, { name: row.name, kind: 'CUSTOM', source: input.source.type });
    await this.queueSync(row.id);
    return this.dto(row);
  }

  async lookalike(id: string, input: z.infer<typeof LookalikeSchema>, actor: AuditActor & { userId: string }) {
    const origin = await this.find(id);
    if (origin.kind !== 'CUSTOM' || !origin.metaAudienceId) throw AppError.validation('Lookalikes are made from saved audiences', [{ field: 'id', issue: 'is a lookalike' }]);
    if (origin.status !== 'READY' || origin.memberCount < AUDIENCE_MIN_SIZE) {
      throw AppError.conflict(`A lookalike needs a source of at least ${AUDIENCE_MIN_SIZE} people`, 'TOO_SMALL');
    }
    const access = await this.usable();
    const name = input.name ?? `${origin.name} - lookalike ${input.country} ${Math.round(input.ratio * 100)}%`.slice(0, 80);
    let metaAudienceId: string;
    try {
      metaAudienceId = await this.ads.createLookalike(access.token, access.row.adAccountId, { name, originAudienceId: origin.metaAudienceId, country: input.country, ratio: input.ratio });
    } catch (error) {
      throw this.refused(error);
    }
    let row: AdAudience;
    try {
      row = await this.prisma.adAudience.create({
        data: {
          name,
          kind: 'LOOKALIKE',
          originAudienceId: origin.id,
          lookalikeCountry: input.country,
          lookalikeRatio: new Prisma.Decimal(input.ratio),
          metaAudienceId,
          status: 'READY',
          syncedAt: new Date(),
          createdById: actor.userId,
        },
      });
    } catch (error) {
      await this.ads.deleteObject(access.token, metaAudienceId).catch(() => undefined);
      if (isUniqueViolation(error)) throw AppError.conflict('An audience with this name exists', 'NAME_TAKEN');
      throw error;
    }
    await this.audit.record(actor, 'ad_audience.created', { type: 'ad_audience', id: row.id }, { name, kind: 'LOOKALIKE', country: input.country, ratio: input.ratio, from: origin.id });
    return this.dto(row);
  }

  /** Deleted here and at Meta, with its lookalikes; refused while a running campaign uses one of them. */
  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.find(id);
    const lookalikes = await this.prisma.adAudience.findMany({ where: { originAudienceId: id, deletedAt: null }, select: { id: true, metaAudienceId: true } });
    const ids = [id, ...lookalikes.map((l) => l.id)];
    const [inUse] = await this.prisma.$queryRaw<Array<{ name: string }>>`
      SELECT name FROM ad_campaigns
       WHERE deleted_at IS NULL AND status IN ('SUBMITTING', 'IN_REVIEW', 'ACTIVE', 'PAUSED')
         AND (targeting->'includeAudienceIds' ?| ${ids}::text[] OR targeting->'excludeAudienceIds' ?| ${ids}::text[])
       LIMIT 1`;
    if (inUse) throw AppError.conflict(`The campaign "${inUse.name}" uses this audience; end it or change its audience first`, 'IN_USE');
    const access = await this.connection.access();
    for (const target of [...lookalikes, { id, metaAudienceId: row.metaAudienceId }]) {
      if (access && target.metaAudienceId) {
        await this.ads.deleteObject(access.token, target.metaAudienceId).catch((e: unknown) => this.logger.warn({ audienceId: target.id, err: e instanceof Error ? e.message : String(e) }, 'Could not delete an audience at Meta'));
      }
    }
    await this.prisma.$transaction([
      this.prisma.adAudience.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date() } }),
      this.prisma.adAudienceMember.deleteMany({ where: { audienceId: { in: ids } } }),
    ]);
    await this.audit.record(actor, 'ad_audience.deleted', { type: 'ad_audience', id }, { name: row.name, lookalikes: lookalikes.length });
  }

  async syncNow(id: string): Promise<void> {
    const row = await this.find(id);
    if (row.kind !== 'CUSTOM') throw AppError.validation('Lookalikes are kept up to date by Meta', [{ field: 'id', issue: 'is a lookalike' }]);
    await this.queueSync(id);
  }

  /** Sends Meta the difference between the source's contacts now and the hashes sent before. */
  async sync(id: string, access: AdsAccess, now = new Date()): Promise<void> {
    const row = await this.prisma.adAudience.findFirst({ where: { id, deletedAt: null, kind: 'CUSTOM' } });
    if (!row?.metaAudienceId) return;
    await this.prisma.adAudience.update({ where: { id }, data: { status: 'SYNCING' } });
    try {
      const wanted = await this.contactsOf(row.source as AudienceSource);
      const sent = new Map((await this.prisma.adAudienceMember.findMany({ where: { audienceId: id }, select: { contactId: true, phoneHash: true } })).map((m) => [m.contactId, m.phoneHash]));
      const add = [...wanted].filter(([contactId, hash]) => sent.get(contactId) !== hash);
      const remove = [...sent].filter(([contactId, hash]) => wanted.get(contactId) !== hash);
      const sentHashes = new Set(sent.values());
      const wantedHashes = new Set(wanted.values());
      const addHashes = [...new Set(add.map(([, h]) => h))].filter((h) => !sentHashes.has(h));
      const removeHashes = [...new Set(remove.map(([, h]) => h))].filter((h) => !wantedHashes.has(h));
      for (let i = 0; i < removeHashes.length; i += AUDIENCE_BATCH) await this.ads.removeAudienceUsers(access.token, row.metaAudienceId, removeHashes.slice(i, i + AUDIENCE_BATCH));
      for (let i = 0; i < addHashes.length; i += AUDIENCE_BATCH) await this.ads.addAudienceUsers(access.token, row.metaAudienceId, addHashes.slice(i, i + AUDIENCE_BATCH));
      await this.prisma.$transaction(async (tx) => {
        if (remove.length) await tx.adAudienceMember.deleteMany({ where: { audienceId: id, contactId: { in: remove.map(([c]) => c) } } });
        if (add.length) {
          await tx.adAudienceMember.deleteMany({ where: { audienceId: id, contactId: { in: add.map(([c]) => c) } } });
          await tx.adAudienceMember.createMany({ data: add.map(([contactId, phoneHash]) => ({ audienceId: id, contactId, phoneHash, addedAt: now })) });
        }
        await tx.adAudience.update({
          where: { id },
          data: { memberCount: wanted.size, status: wanted.size < AUDIENCE_MIN_SIZE ? 'TOO_SMALL' : 'READY', syncedAt: now, lastError: null },
        });
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      await this.prisma.adAudience.update({ where: { id }, data: { status: 'ERROR', lastError: message.slice(0, 500) } });
      if (error instanceof MetaApiError && (error.code === 190 || error.httpStatus === 401)) await this.connection.markError(`Meta stopped accepting the ads token: ${message}`);
      throw error;
    }
  }

  /** contact id → hash of the source's contacts now, without opted-out and blocked contacts. */
  private async contactsOf(source: AudienceSource): Promise<Map<string, string>> {
    const allowed = Prisma.sql`c.consent_status <> 'OPTED_OUT' AND c.blocked_at IS NULL`;
    let rows: Array<{ id: string; phone_e164: string }>;
    if (source.type === 'tag') {
      rows = await this.prisma.$queryRaw`SELECT c.id, c.phone_e164 FROM contacts c JOIN contact_tags t ON t.contact_id = c.id WHERE t.tag_id = ${source.tagId}::uuid AND ${allowed}`;
    } else if (source.type === 'filter') {
      const condition = await this.audiences.compile(source.filter as AudienceFilter);
      rows = await this.prisma.$queryRaw`SELECT c.id, c.phone_e164 FROM contacts c WHERE (${condition}) AND ${allowed}`;
    } else {
      rows = await this.prisma.$queryRaw`
        SELECT DISTINCT c.id, c.phone_e164 FROM messages m JOIN contacts c ON c.id = m.contact_id
         WHERE m.campaign_id = ${source.campaignId}::uuid AND (${retargetCondition(source.group as RetargetGroup)}) AND ${allowed}`;
    }
    const out = new Map<string, string>();
    for (const r of rows) {
      const hash = phoneHash(r.phone_e164);
      if (hash) out.set(r.id, hash);
    }
    return out;
  }

  private async checkSource(source: AudienceSource): Promise<void> {
    if (source.type === 'tag' && !(await this.prisma.tag.findUnique({ where: { id: source.tagId }, select: { id: true } }))) {
      throw AppError.validation('Check the audience', [{ field: 'source.tagId', issue: 'is not a tag' }]);
    }
    if (source.type === 'filter') await this.audiences.compile(source.filter as AudienceFilter);
    if (source.type === 'campaign_group' && !(await this.prisma.campaign.findUnique({ where: { id: source.campaignId }, select: { id: true } }))) {
      throw AppError.validation('Check the audience', [{ field: 'source.campaignId', issue: 'is not a campaign' }]);
    }
  }

  /** A working connection whose ad account accepted the custom audience terms (R2). */
  private async usable(): Promise<AdsAccess> {
    const access = await this.connection.requireUsable();
    const checks = ((access.row.checks ?? {}) as { checks?: Array<{ check: string; result: string }> }).checks ?? [];
    const terms = checks.find((c) => c.check === 'AUDIENCE_TERMS');
    if (terms && terms.result !== 'PASSED') {
      throw AppError.conflict("Accept Meta's custom audience terms for the ad account first, then run the connection checks again", 'TERMS_NOT_ACCEPTED');
    }
    return access;
  }

  private async queueSync(audienceId: string): Promise<void> {
    const data: AdsAudienceSyncData = { audienceId };
    await this.queues.get(QUEUES.ADS).add(ADS_AUDIENCE_SYNC_JOB, data, { jobId: `ads-audience-${audienceId}-${Date.now()}`, attempts: 3, backoff: { type: 'exponential', delay: 30_000 }, removeOnComplete: true, removeOnFail: 20 });
  }

  private async find(id: string): Promise<AdAudience> {
    const row = await this.prisma.adAudience.findFirst({ where: { id, deletedAt: null } });
    if (!row) throw AppError.notFound('Audience not found');
    return row;
  }

  private refused(error: unknown): AppError {
    if (error instanceof MetaApiError) return AppError.validation(`Meta refused: ${error.message}`, [], 'META_REFUSED');
    return error instanceof AppError ? error : AppError.validation(`Meta did not answer: ${error instanceof Error ? error.message : 'unknown error'}`, [], 'META_REFUSED');
  }

  dto(r: AdAudience) {
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      source: (r.source ?? null) as Record<string, unknown> | null,
      originAudienceId: r.originAudienceId,
      lookalikeCountry: r.lookalikeCountry,
      lookalikeRatio: r.lookalikeRatio === null ? null : Number(r.lookalikeRatio),
      status: r.status,
      memberCount: r.memberCount,
      lastError: r.lastError,
      syncedAt: r.syncedAt?.toISOString() ?? null,
    };
  }
}
