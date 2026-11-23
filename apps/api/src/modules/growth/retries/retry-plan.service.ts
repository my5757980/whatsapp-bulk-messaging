import { Injectable } from '@nestjs/common';
import { MAX_RETRY_ROUNDS, RETRY_DELAY_CHOICES, retryPlanProblem } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';

// Retry plan of a campaign (feature 005 US3, FR-013, research R5): 0-3 rounds, each waiting 30
// minutes to 12 hours after the previous attempt, at most 24 hours in all.

export const RetryPlanSchema = z
  .object({
    rounds: z.number().int().min(0).max(MAX_RETRY_ROUNDS),
    delaysMinutes: z
      .array(z.number().int().refine((v) => (RETRY_DELAY_CHOICES as readonly number[]).includes(v), { message: 'choose 30 minutes, 1, 2, 4, 8 or 12 hours' }))
      .max(MAX_RETRY_ROUNDS),
  })
  .strict();
export type RetryPlanInput = z.infer<typeof RetryPlanSchema>;

export interface RetryPlanDto {
  rounds: number;
  delaysMinutes: number[];
}

@Injectable()
export class RetryPlanService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async get(campaignId: string): Promise<RetryPlanDto> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { retryRounds: true, retryDelaysMin: true } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    return { rounds: campaign.retryRounds, delaysMinutes: campaign.retryDelaysMin ?? [] };
  }

  /** Saves the plan of a draft or scheduled campaign (FR-013; audited). */
  async set(campaignId: string, input: RetryPlanInput, actor: AuditActor): Promise<RetryPlanDto> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, select: { state: true, retryRounds: true, retryDelaysMin: true } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    if (campaign.state !== 'DRAFT' && campaign.state !== 'SCHEDULED') {
      throw AppError.conflict('Retries can only change before the campaign starts', 'CAMPAIGN_NOT_EDITABLE');
    }
    const problem = retryPlanProblem(input);
    if (problem === 'RETRY_WINDOW_EXCEEDED') {
      throw AppError.validation('The rounds must all start within 24 hours; choose shorter waits', [{ field: 'delaysMinutes', issue: 'add up to more than 24 hours' }], 'RETRY_WINDOW_EXCEEDED');
    }
    if (problem) throw AppError.validation('Choose one wait for each round', [{ field: 'delaysMinutes', issue: 'needs one wait per round' }]);
    await this.prisma.campaign.update({ where: { id: campaignId }, data: { retryRounds: input.rounds, retryDelaysMin: input.delaysMinutes } });
    await this.audit.record(actor, 'campaign.retry_plan_changed', { type: 'campaign', id: campaignId }, {
      from: { rounds: campaign.retryRounds, delaysMinutes: campaign.retryDelaysMin ?? [] },
      to: input,
    });
    return { rounds: input.rounds, delaysMinutes: input.delaysMinutes };
  }
}
