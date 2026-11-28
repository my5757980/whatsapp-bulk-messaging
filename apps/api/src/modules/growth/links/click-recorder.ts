import { Injectable } from '@nestjs/common';
import type { ClickDeviceKind } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { DripEvents } from '../drips/drip-events.js';
import type { ResolvedLink } from './link-resolver.js';
import { AutoTagService } from '../../contacts/auto-tags.service.js';

/**
 * Records one real click (FR-003): the time, the recipient, the campaign or drip step, the link and
 * the device kind, and never the visitor's address. In the same transaction a click can start drips
 * (a campaign's link) or end one (a drip's own link with the click rule, feature 005 US5). The
 * journey and the chat timeline read clicks from `link_clicks` (FR-009), so open chats are told to
 * refresh.
 */
@Injectable()
export class ClickRecorder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: InboxPublisher,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
    private readonly autoTags: AutoTagService,
  ) {}

  async record(link: ResolvedLink, device: ClickDeviceKind): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.linkClick.create({
        data: {
          trackedLinkId: link.linkId,
          targetId: link.targetId,
          campaignId: link.campaignId,
          dripStepId: link.dripStepId,
          contactId: link.contactId,
          device,
        },
      });
      if (link.contactId) await this.dripEvents.recordClick(tx, link.contactId, { campaignId: link.campaignId, dripId: link.dripId });
      // Automatic tags (feature 010, R4).
      if (link.contactId) await this.autoTags.apply(tx, 'LINK_CLICK', link.contactId);
      // Outbound webhooks (feature 006, FR-002).
      await this.platformEvents.linkClicked(tx, { contactId: link.contactId, campaignId: link.campaignId, dripId: link.dripId, destination: link.destination, device, at: new Date() });
    });
    if (link.contactId) await this.publisher.contactUpdated(link.contactId).catch(() => undefined);
  }
}
