import { Inject, Injectable, Logger } from '@nestjs/common';
import { freeWindow, type AdReferral, type FreeWindow } from '@wbm/shared';
import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { FlowSessionService } from '../../flows/engine/session.service.js';
import { DripEvents } from '../../growth/drips/drip-events.js';
import { JourneyService } from '../../inbox/journey/journey.service.js';
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { newContactKey } from '../../webhooks/handlers/inbound.handler.js';

export interface AdChatMessage {
  numberId: string;
  conversationId: string;
  contactId: string;
  /** The message id; the 001 inbound handler flags messages that created their contact. */
  waMessageId: string;
  /** The chat's state after this message (002: ACTIVE = Open). */
  chatState: 'ACTIVE' | 'REQUESTING' | 'INTERVENED';
  referral: AdReferral;
  occurredAt: Date;
}

/**
 * Chats that start from a Click-to-WhatsApp ad (feature 007 US3, FR-021 – FR-023, research R11),
 * called by the 002 inbound handler before the 006 chat link matcher. The referral's ad id names the
 * version and campaign (ads made outside the platform go under Other ads): the chat start is kept once
 * per contact per ad per day, the contact gets the campaign's tag, the journey and the outbound event
 * record it, and the campaign's flow starts, unless a flow is running or a member has the chat.
 */
@Injectable()
export class AdChatMatcher {
  private readonly logger = new Logger(AdChatMatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: FlowSessionService,
    private readonly journey: JourneyService,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  /** True when the campaign's flow started and so answered the message. */
  async onAdMessage(msg: AdChatMessage): Promise<boolean> {
    const { referral } = msg;
    try {
      const version = await this.prisma.adVersion.findUnique({
        where: { metaAdId: referral.metaAdId },
        select: {
          id: true,
          adCampaign: {
            select: {
              id: true,
              name: true,
              deletedAt: true,
              tagId: true,
              tag: { select: { name: true } },
              flow: { select: { id: true, status: true, deletedAt: true, publishedVersionId: true, allNumbers: true, numbers: { where: { numberId: msg.numberId }, select: { numberId: true } } } },
            },
          },
        },
      });
      const campaign = version && !version.adCampaign.deletedAt ? version.adCampaign : null;
      const newContact = (await this.redis.exists(newContactKey(msg.waMessageId)).catch(() => 0)) > 0;

      const counted = await this.prisma.$transaction(async (tx) => {
        const inserted = await tx.$executeRaw`
          INSERT INTO ad_chat_starts (id, meta_ad_id, ad_campaign_id, ad_version_id, contact_id, conversation_id, new_contact, headline, body, media_url, source_url, ctwa_clid, started_at)
          VALUES (${uuidv7()}::uuid, ${referral.metaAdId}, ${campaign?.id ?? null}::uuid, ${campaign ? version!.id : null}::uuid, ${msg.contactId}::uuid, ${msg.conversationId}::uuid,
                  ${newContact}, ${referral.headline}, ${referral.body}, ${referral.mediaUrl}, ${referral.sourceUrl}, ${referral.ctwaClid}, ${msg.occurredAt})
          ON CONFLICT DO NOTHING`;
        if (!inserted) return false;
        if (campaign?.tagId && campaign.tag) {
          const added = await tx.contactTag.createManyAndReturn({ data: [{ contactId: msg.contactId, tagId: campaign.tagId }], skipDuplicates: true, select: { contactId: true, tagId: true } });
          if (added.length) {
            // As with tags added by flows and chat links: drips that start on the tag, webhook endpoints and the journey.
            await this.dripEvents.recordTagAddedToMany(tx, added);
            await this.platformEvents.tagLinksChanged(tx, added);
            const chats = await tx.conversation.findMany({ where: { contactId: msg.contactId }, select: { id: true } });
            await tx.conversationEvent.createMany({
              data: chats.map((c) => ({ conversationId: c.id, type: 'TAG_ADDED' as const, actorType: 'SYSTEM' as const, data: { tag: campaign.tag!.name, adCampaignName: campaign.name } })),
            });
          }
        }
        await this.platformEvents.adChatStarted(tx, {
          contactId: msg.contactId,
          conversationId: msg.conversationId,
          campaign: campaign ? { id: campaign.id, name: campaign.name } : null,
          metaAdId: referral.metaAdId,
          headline: referral.headline,
          newContact,
          at: msg.occurredAt,
        });
        return true;
      });
      if (!counted) return false;
      await this.journey.recordForContact(msg.contactId, {
        type: 'AD_CHAT_STARTED',
        actorType: 'CUSTOMER',
        data: { metaAdId: referral.metaAdId, headline: referral.headline, adCampaignId: campaign?.id ?? null, adCampaignName: campaign?.name ?? null, newContact },
      });

      const flow = campaign?.flow;
      const runnable = flow && !flow.deletedAt && flow.status === 'PUBLISHED' && flow.publishedVersionId && (flow.allNumbers || flow.numbers.length > 0);
      if (!runnable || msg.chatState !== 'ACTIVE') return false;
      // A running session refuses the start ('busy'); the flow router then gives it this message.
      const outcome = await this.sessions.start({ flowId: flow.id, versionId: flow.publishedVersionId!, conversationId: msg.conversationId, startedBy: 'TRIGGER', triggerKey: 'ad' });
      return outcome.started;
    } catch (error) {
      // An ads problem never stops live chat, flows or the AI agent from handling the message.
      this.logger.error({ err: (error as Error).message, conversationId: msg.conversationId }, 'Ad chat matching failed');
      return false;
    }
  }
}

/** Business messages that open Meta's free window when sent within 24 hours of the ad chat (R11). */
const BUSINESS_KINDS = ['SESSION_OUT', 'MESSAGE_REF'] as const;

export type FreeWindowDto = { state: 'REPLY_TO_OPEN'; replyBy: string } | { state: 'OPEN' | 'ENDED'; until: string } | { state: 'MISSED' };

export function freeWindowDto(window: FreeWindow): FreeWindowDto {
  if (window.state === 'REPLY_TO_OPEN') return { state: window.state, replyBy: window.replyBy.toISOString() };
  if (window.state === 'OPEN' || window.state === 'ENDED') return { state: window.state, until: window.until.toISOString() };
  return { state: 'MISSED' };
}

/** The latest ad chat of a conversation, for the live chat ad card (FR-021, FR-023). */
@Injectable()
export class AdChatInfo {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async forConversation(conversationId: string, now = new Date()) {
    const start = await this.prisma.adChatStart.findFirst({
      where: { conversationId },
      orderBy: { startedAt: 'desc' },
      select: { metaAdId: true, headline: true, body: true, mediaUrl: true, sourceUrl: true, startedAt: true, newContact: true, adCampaign: { select: { id: true, name: true } } },
    });
    if (!start) return null;
    const reply = await this.prisma.chatMessage.findFirst({
      where: { conversationId, kind: { in: [...BUSINESS_KINDS] }, occurredAt: { gte: start.startedAt }, OR: [{ status: null }, { status: { not: 'FAILED' } }] },
      orderBy: { occurredAt: 'asc' },
      select: { occurredAt: true },
    });
    return {
      metaAdId: start.metaAdId,
      headline: start.headline,
      body: start.body,
      mediaUrl: start.mediaUrl,
      sourceUrl: start.sourceUrl,
      startedAt: start.startedAt.toISOString(),
      newContact: start.newContact,
      adCampaign: start.adCampaign,
      freeWindow: freeWindowDto(freeWindow(start.startedAt, reply?.occurredAt ?? null, now, this.config.ADS_FREE_WINDOW_HOURS)),
    };
  }
}
