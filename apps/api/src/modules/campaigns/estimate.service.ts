import { Injectable } from '@nestjs/common';
import type { MetaTemplateComponent } from '@wbm/shared';
import { AppError } from '../../common/errors/app-error.js';
import { maskPhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { RateCardService } from '../rate-card/rate-card.controller.js';
import { microsToUsdNumber, rateCategory } from '../reports/cost-calculator.js';
import { AudienceSnapshotService } from './audience-snapshot.service.js';
import { renderBodyPreview } from './variable-resolver.js';

// POST /campaigns/{id}/estimate (T095): eligible/excluded counts and three rendered previews.
// The USD cost is added once a rate card exists (US5), so it is omitted for now.

/** Parses tiers such as TIER_250, TIER_1K, TIER_100K; null when unlimited or unknown. */
export function tierLimit(tier: string | null | undefined): number | null {
  const m = /(\d+)\s*([KM]?)/i.exec(tier ?? '');
  if (!m) return null;
  const base = Number(m[1]);
  const unit = (m[2] ?? '').toUpperCase();
  return unit === 'K' ? base * 1_000 : unit === 'M' ? base * 1_000_000 : base;
}

export function bodyText(components: unknown): string {
  const list = (Array.isArray(components) ? components : []) as MetaTemplateComponent[];
  return list.find((c) => c.type.toUpperCase() === 'BODY')?.text ?? '';
}

@Injectable()
export class EstimateService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly snapshot: AudienceSnapshotService,
    private readonly rateCard: RateCardService,
  ) {}

  async estimate(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, include: { template: true, number: true } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    if (!campaign.template) throw AppError.validation('Choose a template first', [{ field: 'templateId', issue: 'is required' }]);

    const excluded = { optedOut: 0, noOptIn: 0, invalidNumber: 0, duplicate: 0, missingVariable: 0 };
    if (campaign.audienceType === 'UPLOAD') {
      const { job, rows } = await this.snapshot.readyUpload(campaignId);
      excluded.invalidNumber = job.errorCount;
      excluded.duplicate = Math.max(0, job.totalRows - job.errorCount - rows);
    } else {
      await this.snapshot.assertReady(campaign);
    }
    const perCountry = new Map<string, number>();
    let eligible = 0;
    const previews: Array<{ phoneMasked: string; text: string }> = [];
    const text = bodyText(campaign.template.components);

    for await (const batch of this.snapshot.evaluate(campaign, campaign.template)) {
      for (const r of batch) {
        if (r.status === 'PENDING') {
          eligible++;
          perCountry.set(r.countryCode, (perCountry.get(r.countryCode) ?? 0) + 1);
          if (previews.length < 3) previews.push({ phoneMasked: maskPhone(r.phoneE164) ?? '', text: renderBodyPreview(text, r.params) });
        } else if (r.skipReason === 'OPTED_OUT') excluded.optedOut++;
        else if (r.skipReason === 'NO_OPT_IN') excluded.noOptIn++;
        else if (r.skipReason === 'MISSING_VARIABLE') excluded.missingVariable++;
      }
    }

    const limit = tierLimit(campaign.number?.messagingLimitTier);
    const messagingLimitWarning =
      limit !== null && eligible > limit
        ? `This campaign reaches ${eligible} people, but the number's messaging limit is ${limit} unique people per 24 hours.`
        : null;
    // Pre-launch cost: eligible recipients x the rate for the template category and their country.
    const table = await this.rateCard.table();
    let costMicros = 0n;
    let uncostedRecipients = 0;
    const category = rateCategory(null, campaign.template.category);
    for (const [country, count] of perCountry) {
      const rate = table.rate(category, country);
      if (rate === null) uncostedRecipients += count;
      else costMicros += rate * BigInt(count);
    }
    return {
      eligible,
      excluded,
      messagingLimitWarning,
      previews,
      ...(table.isEmpty ? {} : { estimatedCostUsd: microsToUsdNumber(costMicros), uncostedRecipients }),
    };
  }
}
