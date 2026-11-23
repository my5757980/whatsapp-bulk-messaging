import { Injectable } from '@nestjs/common';
import { withCampaignTags } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';

/** A tracked link found by its code, with where it sends the visitor now (FR-006). */
export interface ResolvedLink {
  linkId: string;
  messageId: string;
  contactId: string | null;
  targetId: string;
  campaignId: string | null;
  dripStepId: string | null;
  dripId: string | null;
  /** The campaign or drip name: campaign tags and the journey name it. */
  ownerName: string | null;
  destination: string;
}

/** The stored destination, with the campaign tags when they are switched on (FR-007). */
export function finalDestination(target: { destination: string; addCampaignTags: boolean }, ownerName: string | null): string {
  return target.addCampaignTags && ownerName ? withCampaignTags(target.destination, ownerName) : target.destination;
}

/** Looks a code up in one indexed query (SC-001). */
@Injectable()
export class LinkResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(code: string): Promise<ResolvedLink | null> {
    const link = await this.prisma.trackedLink.findUnique({
      where: { code },
      select: {
        id: true,
        messageId: true,
        contactId: true,
        target: {
          select: {
            id: true,
            campaignId: true,
            dripStepId: true,
            destination: true,
            addCampaignTags: true,
            campaign: { select: { name: true } },
            dripStep: { select: { dripId: true, drip: { select: { name: true } } } },
          },
        },
      },
    });
    if (!link) return null;
    const { target } = link;
    const ownerName = target.campaign?.name ?? target.dripStep?.drip.name ?? null;
    return {
      linkId: link.id,
      messageId: link.messageId,
      contactId: link.contactId,
      targetId: target.id,
      campaignId: target.campaignId,
      dripStepId: target.dripStepId,
      dripId: target.dripStep?.dripId ?? null,
      ownerName,
      destination: finalDestination(target, ownerName),
    };
  }
}
