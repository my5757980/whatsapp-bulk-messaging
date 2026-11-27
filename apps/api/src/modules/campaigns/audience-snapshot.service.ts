import { randomInt } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { amountProblem, makeLinkCode, toMinorUnits, type SkipReason } from '@wbm/shared';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { Prisma, type Campaign, type ImportJob, type Template } from '../../generated/prisma/client.js';
import { AudienceQueryBuilder, type AudienceContact, type AudienceFilter, type FilterAudience } from '../contacts/audience-query.builder.js';
import { TrackedLinkCodes } from '../growth/links/link-codes.js';
import { paymentWords } from '../payments/requests/payment-views.js';
import { campaignPaymentConfig, type CampaignPaymentConfig, type CampaignPaymentContext, type RecipientPayment } from './campaign-payments.port.js';
import { retargetCondition, type RetargetGroup } from './retarget.service.js';
import { resolveVariables, type VariableMapping } from './variable-resolver.js';

// Recipient evaluation shared by the estimate (T095) and the launch snapshot (T096). Consent is
// enforced here first (research R11): opted-out contacts are skipped, and MARKETING templates
// need an explicit opt-in. Tracked-link variables (feature 005) need no mapping: they carry a
// sample link here and each recipient's own code from the launch.

export interface RecipientDecision {
  contactId: string;
  phoneE164: string;
  countryCode: string;
  status: 'PENDING' | 'SKIPPED';
  skipReason: SkipReason | null;
  params: Record<string, string>;
  customerName?: string | null;
  /** The payment request this recipient gets (campaigns with a payment config, feature 008). */
  payment?: RecipientPayment;
}

/** A payment campaign's settings for the snapshot. */
interface PaymentPlan {
  config: CampaignPaymentConfig;
  context: CampaignPaymentContext;
  buttonKey: string;
}

/** `{name}` and `{attr:key}` in a campaign's payment description. */
function fillDescription(text: string, contact: AudienceContact): string {
  const attributes = (contact.attributes ?? {}) as Record<string, unknown>;
  const filled = text.replace(/\{name\}/g, contact.name ?? '').replace(/\{attr:([a-z0-9_]+)\}/gi, (_m, key: string) => String(attributes[key] ?? ''));
  return filled.trim().slice(0, 250) || text.slice(0, 250);
}

type Db = PrismaService | Prisma.TransactionClient;

const BATCH = 1000;

@Injectable()
export class AudienceSnapshotService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: AudienceQueryBuilder,
    private readonly codes: TrackedLinkCodes,
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

  /** Contacts of the source campaign whose message is in the retarget group (RETARGET; 005 adds groups). */
  private async *retargetContacts(
    campaign: Pick<Campaign, 'sourceCampaignId' | 'retargetStatus'>,
    db: Db,
  ): AsyncGenerator<Array<AudienceContact & { row_data: unknown }>> {
    if (!campaign.retargetStatus) return;
    const inGroup = retargetCondition(campaign.retargetStatus as RetargetGroup);
    let cursor: string | null = null;
    for (;;) {
      const after: Prisma.Sql = cursor ? Prisma.sql`AND c.id > ${cursor}::uuid` : Prisma.empty;
      const rows: Array<AudienceContact & { row_data: unknown }> = await db.$queryRaw<Array<AudienceContact & { row_data: unknown }>>`
        SELECT c.id, c.phone_e164, c.country_code, c.name, c.attributes, c.consent_status, r.data AS row_data
          FROM messages m
          JOIN contacts c ON c.id = m.contact_id
          LEFT JOIN campaign_upload_rows r ON r.campaign_id = m.campaign_id AND r.phone_e164 = c.phone_e164
         WHERE m.campaign_id = ${campaign.sourceCampaignId}::uuid AND ${inGroup} ${after}
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
    campaign: Pick<Campaign, 'id' | 'audienceType' | 'audienceFilter' | 'variableMapping' | 'sourceCampaignId' | 'retargetStatus' | 'paymentConfig'>,
    template: Pick<Template, 'category' | 'variables'>,
    db: Db = this.prisma,
    payment: CampaignPaymentContext | null = null,
  ): AsyncGenerator<RecipientDecision[]> {
    const all = (Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>;
    const tracked = await this.trackedKeys(campaign.id, all, db);
    const config = payment ? campaignPaymentConfig(campaign.paymentConfig) : null;
    const plan: PaymentPlan | null = config && payment ? { config, context: payment, buttonKey: `BUTTON.${payment.buttonIndex}.1` } : null;
    // The pay link button needs no mapping: it carries each recipient's request code.
    const variables = all.filter((v) => !tracked.has(v.key) && v.key !== plan?.buttonKey);
    const samples = Object.fromEntries([...tracked].map((key) => [key, this.codes.sampleValue(key)]));
    const mapping = (campaign.variableMapping ?? {}) as VariableMapping;
    const marketing = template.category === 'MARKETING';
    const decide = (c: AudienceContact, row: Record<string, unknown>) => this.decide(c, row, variables, mapping, marketing, samples, plan);

    if (campaign.audienceType === 'RETARGET') {
      // Uploaded columns of the source campaign still feed "column" variables.
      for await (const contacts of this.retargetContacts(campaign, db)) {
        yield contacts.map((c) => decide(c, (c.row_data ?? {}) as Record<string, unknown>));
      }
      return;
    }
    if (campaign.audienceType !== 'UPLOAD') {
      for await (const contacts of this.audience.iterate(this.filterAudience(campaign), db)) {
        yield contacts.map((c) => decide(c, {}));
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
        decisions.push(decide(asAudience, (row.data ?? {}) as Record<string, unknown>));
      }
      yield decisions;
    }
  }

  /** The template variables that carry a tracked link in this campaign (feature 005). */
  async trackedKeys(campaignId: string, variables: ReadonlyArray<{ key: string }>, db: Db = this.prisma): Promise<Set<string>> {
    const keys = new Set(variables.map((v) => v.key));
    const rows = await db.trackedLinkTarget.findMany({ where: { campaignId }, select: { variableKey: true } });
    return new Set(rows.map((r) => r.variableKey).filter((key) => keys.has(key)));
  }

  private decide(
    contact: AudienceContact,
    row: Record<string, unknown>,
    variables: Array<{ key: string }>,
    mapping: VariableMapping,
    marketing: boolean,
    samples: Record<string, string>,
    plan: PaymentPlan | null = null,
  ): RecipientDecision {
    const base = { contactId: contact.id, phoneE164: contact.phone_e164, countryCode: contact.country_code, params: {}, customerName: contact.name };
    if (contact.consent_status === 'OPTED_OUT') return { ...base, status: 'SKIPPED', skipReason: 'OPTED_OUT' };
    if (marketing && contact.consent_status !== 'OPTED_IN') return { ...base, status: 'SKIPPED', skipReason: 'NO_OPT_IN' };
    let payment: RecipientPayment | undefined;
    if (plan) {
      const amountMinor = this.paymentAmount(plan, contact);
      if (amountMinor === null) return { ...base, status: 'SKIPPED', skipReason: 'PAYMENT_AMOUNT_MISSING' };
      payment = { code: makeLinkCode(randomInt), amountMinor, description: fillDescription(plan.config.description, contact), expiresAt: new Date(Date.now() + plan.config.expiryMinutes * 60_000) };
    }
    const resolved = resolveVariables(variables, mapping, {
      contact: { name: contact.name, phone: contact.phone_e164, attributes: contact.attributes },
      row,
      ...(payment && plan ? { payment: paymentWords({ ...payment, amountMinor: BigInt(payment.amountMinor), currency: plan.context.currency, reference: null }, plan.context.linkBase, plan.context.timeZone) } : {}),
    });
    if (!resolved.ok) return { ...base, status: 'SKIPPED', skipReason: 'MISSING_VARIABLE' };
    // Feature 008: catalog and multi-product templates carry the campaign's product choices.
    const products = mapping['$products'];
    const params = { ...resolved.params, ...samples, ...(payment && plan ? { [plan.buttonKey]: payment.code } : {}), ...(products?.source === 'static' && products.value ? { $products: products.value } : {}) };
    return { ...base, status: 'PENDING', skipReason: null, params, ...(payment ? { payment } : {}) };
  }

  /** A recipient's amount in minor units: fixed, or a positive number attribute in major units; null when missing or outside the limits. */
  private paymentAmount(plan: PaymentPlan, contact: AudienceContact): number | null {
    const amount = plan.config.amount;
    let minor: number;
    if (amount.source === 'static') minor = amount.minor;
    else {
      const raw = ((contact.attributes ?? {}) as Record<string, unknown>)[amount.attributeKey];
      const major = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : Number.NaN;
      if (!Number.isFinite(major) || major <= 0) return null;
      minor = toMinorUnits(major, plan.context.currency);
    }
    return amountProblem(minor, plan.context.currency, plan.context.maxAmountMinor) ? null : minor;
  }
}
