import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { CampaignsService } from './campaigns.service.js';

// Retargeting (FR-031, T163): a new DRAFT whose RETARGET audience is the source campaign's
// recipients with a given status. Recipients are snapshotted when it launches, and contacts who
// have opted out since are excluded by the usual consent rules.

export const RetargetSchema = z.object({ status: z.enum(['FAILED', 'NOT_READ', 'READ', 'DELIVERED']) }).strict();
export type RetargetInput = z.infer<typeof RetargetSchema>;

/** Message statuses that make up each retarget group. */
export const RETARGET_STATUSES: Record<RetargetInput['status'], Array<'SENT' | 'DELIVERED' | 'READ' | 'FAILED'>> = {
  FAILED: ['FAILED'],
  NOT_READ: ['SENT', 'DELIVERED'],
  READ: ['READ'],
  DELIVERED: ['DELIVERED', 'READ'],
};

const LABEL: Record<RetargetInput['status'], string> = { FAILED: 'failed', NOT_READ: 'not read', READ: 'read', DELIVERED: 'delivered' };

@Injectable()
export class RetargetService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly campaigns: CampaignsService,
  ) {}

  async retarget(sourceId: string, input: RetargetInput, userId: string) {
    const source = await this.campaigns.getRow(sourceId);
    if (source.state === 'DRAFT' || source.state === 'SCHEDULED') throw AppError.conflict('Retarget a campaign once it has started sending');
    const created = await this.prisma.campaign.create({
      data: {
        name: `${source.name} - retarget ${LABEL[input.status]}`.slice(0, 120),
        numberId: source.numberId,
        templateId: source.templateId,
        audienceType: 'RETARGET',
        sourceCampaignId: source.id,
        retargetStatus: input.status,
        variableMapping: (source.variableMapping ?? {}) as Prisma.InputJsonValue,
        headerMediaAssetId: source.headerMediaAssetId,
        timezone: source.timezone,
        createdById: userId,
      },
    });
    return this.campaigns.get(created.id);
  }
}
