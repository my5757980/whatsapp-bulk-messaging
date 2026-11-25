import { Body, Controller, Get, HttpCode, Post, Query } from '@nestjs/common';
import { AD_GOALS, metaTargeting, normalizePlacements, placementProblems, targetingProblems, type AdPlacements, type AdTargeting } from '@wbm/shared';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { MetaApiError } from '../../meta/meta-graph.client.js';
import { AdsConnectionService, type AdsAccess } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';
import { PlacementsSchema, TargetingSchema } from './ad-campaigns.service.js';

// Targeting search and estimates (feature 007 US2, FR-008 – FR-011, research R5): Meta's own lists,
// the audience range and the minimum daily budget for the ad account's currency.

const SearchSchema = z.object({ q: z.string().trim().min(2).max(80) }).strict();
const EstimateSchema = z.object({ goal: z.enum(AD_GOALS), targeting: TargetingSchema, placements: PlacementsSchema.optional() }).strict();
const OPTIMIZATION = { CHATS: 'CONVERSATIONS', LEADS: 'LEAD_GENERATION', WEBSITE: 'LINK_CLICKS' } as const;

@Controller('ads/targeting')
export class AdTargetingController {
  constructor(
    private readonly connection: AdsConnectionService,
    private readonly ads: MetaAdsClient,
    private readonly prisma: PrismaService,
  ) {}

  @Get('locations')
  @Require('campaigns.manage')
  async locations(@Query(new ZodValidationPipe(SearchSchema)) query: { q: string }) {
    const access = await this.access();
    return this.read(() => this.ads.searchLocations(access.token, query.q));
  }

  @Get('interests')
  @Require('campaigns.manage')
  async interests(@Query(new ZodValidationPipe(SearchSchema)) query: { q: string }) {
    const access = await this.access();
    return this.read(() => this.ads.searchInterests(access.token, query.q));
  }

  @Post('estimate')
  @HttpCode(200)
  @Require('campaigns.manage')
  async estimate(@Body(new ZodValidationPipe(EstimateSchema)) body: z.infer<typeof EstimateSchema>) {
    const access = await this.access();
    const targeting = body.targeting as AdTargeting;
    const placements = normalizePlacements((body.placements ?? { auto: true }) as AdPlacements);
    const problems = [...targetingProblems(targeting), ...placementProblems(placements, body.goal)];
    if (problems.length) throw AppError.validation('Check the audience', problems);
    const ids = [...(targeting.includeAudienceIds ?? []), ...(targeting.excludeAudienceIds ?? [])];
    const audiences = ids.length ? await this.prisma.adAudience.findMany({ where: { id: { in: ids } }, select: { id: true, metaAudienceId: true } }) : [];
    const metaIds = (list: string[] | undefined) => (list ?? []).map((id) => audiences.find((a) => a.id === id)?.metaAudienceId).filter((x): x is string => Boolean(x));
    const spec = metaTargeting(targeting, placements, { include: metaIds(targeting.includeAudienceIds), exclude: metaIds(targeting.excludeAudienceIds) });
    const [estimate, min] = await Promise.all([
      // Meta cannot always estimate (e.g. with custom audiences); the range is then unknown.
      this.ads.deliveryEstimate(access.token, access.row.adAccountId, spec, OPTIMIZATION[body.goal]).catch(() => ({ lower: null, upper: null })),
      this.read(() => this.ads.minimumDailyBudget(access.token, access.row.adAccountId)),
    ]);
    return { audienceLower: estimate.lower, audienceUpper: estimate.upper, currency: access.row.currency, minDailyBudgetMinor: min.minDailyBudgetMinor };
  }

  private async access(): Promise<AdsAccess> {
    const access = await this.connection.access();
    if (!access) throw AppError.conflict('Connect the ad account first (Ads > Connect)', 'NOT_CONNECTED');
    return access;
  }

  private async read<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      if (error instanceof MetaApiError) throw AppError.validation(`Meta refused: ${error.message}`, [], 'META_REFUSED');
      throw error;
    }
  }
}
