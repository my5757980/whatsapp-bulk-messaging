import { Injectable } from '@nestjs/common';
import type { ClickDeviceKind } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import type { ResolvedLink } from './link-resolver.js';

/**
 * Records one real click (FR-003): the time, the recipient, the campaign or drip step, the link and
 * the device kind, and never the visitor's address. The journey and the chat timeline read clicks
 * from `link_clicks` (FR-009), so open chats are told to refresh.
 */
@Injectable()
export class ClickRecorder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly publisher: InboxPublisher,
  ) {}

  async record(link: ResolvedLink, device: ClickDeviceKind): Promise<void> {
    await this.prisma.linkClick.create({
      data: {
        trackedLinkId: link.linkId,
        targetId: link.targetId,
        campaignId: link.campaignId,
        dripStepId: link.dripStepId,
        contactId: link.contactId,
        device,
      },
    });
    if (link.contactId) await this.publisher.contactUpdated(link.contactId).catch(() => undefined);
  }
}
