import { Injectable } from '@nestjs/common';
import type { SkipReason } from '@wbm/shared';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma, type Campaign, type ImportJob, type Template } from '../../generated/prisma/client.js';
import { AudienceQueryBuilder, type AudienceContact, type AudienceFilter, type FilterAudience } from '../contacts/audience-query.builder.js';
import { RETARGET_STATUSES } from './retarget.service.js';
import { resolveVariables, type VariableMapping } from './variable-resolver.js';

// Recipient evaluation shared by the estimate (T095) and the launch snapshot (T096). Consent is
// enforced here first (research R11): opted-out contacts are skipped, and MARKETING templates
// need an explicit opt-in.

export interface RecipientDecision {
  contactId: string;
  phoneE164: string;
  countryCode: string;
  status: 'PENDING' | 'SKIPPED';
  skipReason: SkipReason | null;
  params: Record<string, string>;
}

type Db = PrismaService | Prisma.TransactionClient;

const BATCH = 1000;

@Injectable()
export class AudienceSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: AudienceQueryBuilder,
  ) {}

  /** The filter audience of a FILTER / ALL_OPTED_IN campaign; FILTER needs at least one rule. */
  filterAudience(campaign: Pick<Campaign, 'audienceType' | 'audienceFilter'>): FilterAudience {
    if (campaign.audienceType === 'ALL_OPTED_IN') return { type: 'ALL_OPTED_IN' };
    const filter = campaign.audienceFilter as AudienceFilter | null;
    if (!filter?.all?.length) {
      throw AppError.validation('Add at least one filter rule, or choose All opted-in', [{ field: 'audienceFilter', issue: 'needs at least one rule' }]);
    }
    return { type: 'FILTER', filter };
  }

  /** Throws a readable error when the campaign's audience cannot be evaluated yet. */
  async assertReady(campaign: Pick<Campaign, 'id' | 'audienceType' | 'audienceFilter' | 'sourceCampaignId' | 'retargetStatus'>, db: Db = this.prisma): Promise<void> {
    if (campaign.audienceType === 'UPLOAD') await this.readyUpload(campaign.id, db);
    else if (campaign.audienceType === 'RETARGET') {
      if (!campaign.sourceCampaignId || !campaign.retargetStatus) {
        throw AppError.validation('This retarget draft has no source campaign', [{ field: 'audienceType', issue: 'choose another audience' }]);
      }
    } else this.filterAudience(campaign);
  }

  /** Contacts of the source campaign whose message has one of the statuses (RETARGET). */
  private async *retargetContacts(
    campaign: Pick<Campaign, 'sourceCampaignId' | 'retargetStatus'>,
    db: Db,
  ): AsyncGenerator<Array<AudienceContact & { row_data: unknown }>> {
    const statuses = RETARGET_STATUSES[campaign.retargetStatus as keyof typeof RETARGET_STATUSES] ?? [];
    const statusList = Prisma.join(statuses.map((s) => Prisma.sql`${s}::"MessageStatus"`));
    let cursor: string | null = null;
    for (;;) {
      const after: Prisma.Sql = cursor ? Prisma.sql`AND c.id > ${cursor}::uuid` : Prisma.empty;
      const rows: Array<AudienceContact & { row_data: unknown }> = await db.$queryRaw<Array<AudienceContact & { row_data: unknown }>>`
        SELECT c.id, c.phone_e164, c.country_code, c.name, c.attributes, c.consent_status, r.data AS row_data
          FROM messages m
          JOIN contacts c ON c.id = m.contact_id
          LEFT JOIN campaign_upload_rows r ON r.campaign_id = m.campaign_id AND r.phone_e164 = c.phone_e164
         WHERE m.campaign_id = ${campaign.sourceCampaignId}::uuid AND m.status IN (${statusList}) ${after}
         ORDER BY c.id
         LIMIT ${BATCH}`;
      if (!rows.length) return;
      cursor = rows[rows.length - 1]!.id;
      yield rows;
      if (rows.length < BATCH) return;
    }
  }

  /** The latest completed upload for a campaign, or a readable error when it is not ready. */
  async readyUpload(campaignId: string, db: Db = this.prisma): Promise<{ job: ImportJob; rows: number }> {
    const job = await db.importJob.findFirst({ where: { campaignId, kind: 'CAMPAIGN_AUDIENCE' }, orderBy: { createdAt: 'desc' } });
    if (!job) throw AppError.validation('Upload a recipient list first', [{ field: 'audience', issue: 'no recipient list uploaded' }]);
    if (job.status === 'QUEUED' || job.status === 'PROCESSING') throw AppError.conflict('The recipient list is still being processed');
    if (job.status === 'FAILED') throw AppError.validation(`The last upload failed: ${job.error ?? 'unknown error'}`);
    const rows = await db.campaignUploadRow.count({ where: { campaignId } });
    if (!rows) throw AppError.validation('The uploaded list has no valid recipients', [{ field: 'audience', issue: 'no valid phone numbers' }]);
    return { job, rows };
  }

  /** Yields recipient decisions in batches, in upload order. */
  async *evaluate(
    campaign: Pick<Campaign, 'id' | 'audienceType' | 'audienceFilter' | 'variableMapping' | 'sourceCampaignId' | 'retargetStatus'>,
    template: Pick<Template, 'category' | 'variables'>,
    db: Db = this.prisma,
  ): AsyncGenerator<RecipientDecision[]> {
    const variables = (Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>;
    const mapping = (campaign.variableMapping ?? {}) as VariableMapping;
    const marketing = template.category === 'MARKETING';

    if (campaign.audienceType === 'RETARGET') {
      // Uploaded columns of the source campaign still feed "column" variables.
      for await (const contacts of this.retargetContacts(campaign, db)) {
        yield contacts.map((c) => this.decide(c, (c.row_data ?? {}) as Record<string, unknown>, variables, mapping, marketing));
      }
      return;
    }
    if (campaign.audienceType !== 'UPLOAD') {
      for await (const contacts of this.audience.iterate(this.filterAudience(campaign), db)) {
        yield contacts.map((c) => this.decide(c, {}, variables, mapping, marketing));
      }
      return;
    }

    let cursor: string | undefined;
    for (;;) {
      const rows = await db.campaignUploadRow.findMany({
        where: { campaignId: campaign.id },
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!rows.length) return;
      cursor = rows[rows.length - 1]!.id;

      const contacts = await db.contact.findMany({
        where: { phoneE164: { in: rows.map((r) => r.phoneE164) } },
        select: { id: true, phoneE164: true, countryCode: true, name: true, attributes: true, consentStatus: true },
      });
      const byPhone = new Map(contacts.map((c) => [c.phoneE164, c]));

      const decisions: RecipientDecision[] = [];
      for (const row of rows) {
        const contact = byPhone.get(row.phoneE164);
        if (!contact) continue; // deleted since the upload (FR-015)
        const asAudience: AudienceContact = {
          id: contact.id,
          phone_e164: contact.phoneE164,
          country_code: contact.countryCode,
          name: contact.name,
          attributes: contact.attributes,
          consent_status: contact.consentStatus,
        };
        decisions.push(this.decide(asAudience, (row.data ?? {}) as Record<string, unknown>, variables, mapping, marketing));
      }
      yield decisions;
    }
  }

  private decide(
    contact: AudienceContact,
    row: Record<string, unknown>,
    variables: Array<{ key: string }>,
    mapping: VariableMapping,
    marketing: boolean,
  ): RecipientDecision {
    const base = { contactId: contact.id, phoneE164: contact.phone_e164, countryCode: contact.country_code, params: {} };
    if (contact.consent_status === 'OPTED_OUT') return { ...base, status: 'SKIPPED', skipReason: 'OPTED_OUT' };
    if (marketing && contact.consent_status !== 'OPTED_IN') return { ...base, status: 'SKIPPED', skipReason: 'NO_OPT_IN' };
    const resolved = resolveVariables(variables, mapping, {
      contact: { name: contact.name, phone: contact.phone_e164, attributes: contact.attributes },
      row,
    });
    return resolved.ok
      ? { ...base, status: 'PENDING', skipReason: null, params: resolved.params }
      : { ...base, status: 'SKIPPED', skipReason: 'MISSING_VARIABLE' };
  }
}
