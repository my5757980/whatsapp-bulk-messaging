import { randomInt } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { makeLinkCode, metaTargeting, type AdPlacements, type AdTargeting } from '@wbm/shared';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { StorageService } from '../../../common/storage/storage.service.js';
import type { AdCampaign, AdLeadForm, AdVersion, MediaAsset, WhatsAppNumber } from '../../../generated/prisma/client.js';
import type { AdsAccess } from '../connection/ads-connection.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';

// Making a campaign at Meta (feature 007 US2, FR-012, FR-013, research R3, R4): media from the 001
// library, the welcome message sequence for chat ads, one creative per version, the campaign, the ad
// set and one ad per version. A failure part way deletes what was made, so a retry starts clean.

type Version = AdVersion & { mediaAsset: MediaAsset };
type Campaign = AdCampaign & { versions: Version[]; number: WhatsAppNumber | null; leadForm: AdLeadForm | null };

const OBJECTIVE = { CHATS: 'OUTCOME_ENGAGEMENT', LEADS: 'OUTCOME_LEADS', WEBSITE: 'OUTCOME_TRAFFIC' } as const;
const SPECIAL = { NONE: null, CREDIT: 'CREDIT', EMPLOYMENT: 'EMPLOYMENT', HOUSING: 'HOUSING', SOCIAL_ISSUES: 'ISSUES_ELECTIONS_POLITICS' } as const;
const WHATSAPP_LINK = 'https://api.whatsapp.com/send';
const LEAD_LINK = 'http://fb.me/';

/** The counted link of a website ad (R10). */
export function adLinkUrl(base: string | undefined, code: string | null): string | null {
  return base && code ? `${base.replace(/\/+$/, '')}/a/${code}` : null;
}

/** A code in the 005 link format, unguessable. */
export function newLinkCode(): string {
  return makeLinkCode((max) => randomInt(max));
}

@Injectable()
export class AdLauncher {
  private readonly logger = new Logger(AdLauncher.name);
  /** Waits for Meta's video processing (tests shorten it). */
  static videoWaitMs = 3_000;
  static videoTries = 100;

  constructor(
    private readonly prisma: PrismaService,
    private readonly ads: MetaAdsClient,
    private readonly storage: StorageService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Makes the whole campaign at Meta and saves Meta's ids; the versions go to review. */
  async launch(campaignId: string, access: AdsAccess, now = new Date()): Promise<void> {
    const c = await this.load(campaignId);
    const { token } = access;
    const account = access.row.adAccountId;
    const made: string[] = [];
    try {
      for (const v of c.versions) await this.upload(v, access);
      const versions = (await this.load(campaignId)).versions;

      let sequenceId = c.welcomeSequenceId;
      if (c.goal === 'CHATS' && c.prefilledMessage && !sequenceId) {
        sequenceId = await this.ads.createWelcomeSequence(token, c.number!.wabaId, c.name.slice(0, 100), c.prefilledMessage);
        await this.prisma.adCampaign.update({ where: { id: c.id }, data: { welcomeSequenceId: sequenceId } });
      }
      let linkCode = c.linkCode;
      if (c.goal === 'WEBSITE' && !linkCode) {
        linkCode = newLinkCode();
        await this.prisma.adCampaign.update({ where: { id: c.id }, data: { linkCode } });
      }
      const linkUrl = adLinkUrl(this.config.PUBLIC_LINK_BASE_URL, linkCode);

      const creativeIds = new Map<string, string>();
      for (const v of versions) {
        const id = await this.ads.create(token, account, 'adcreatives', await this.creative(c, v, access, sequenceId, linkUrl));
        made.push(id);
        creativeIds.set(v.id, id);
      }
      const metaCampaignId = await this.ads.create(token, account, 'campaigns', this.campaignSpec(c));
      made.push(metaCampaignId);
      const metaAdsetId = await this.ads.create(token, account, 'adsets', await this.adsetSpec(c, metaCampaignId, access, now));
      made.push(metaAdsetId);
      const adIds = new Map<string, string>();
      for (const v of versions) {
        const id = await this.ads.create(token, account, 'ads', { name: `${c.name} - version ${v.position}`, adset_id: metaAdsetId, creative: { creative_id: creativeIds.get(v.id) }, status: 'ACTIVE' });
        made.push(id);
        adIds.set(v.id, id);
      }

      await this.prisma.$transaction([
        this.prisma.adCampaign.update({
          where: { id: c.id },
          data: { metaCampaignId, metaAdsetId, metaStatus: 'ACTIVE', status: 'IN_REVIEW', submittedAt: now, startAt: c.startAt < now ? now : c.startAt, lastError: null },
        }),
        ...versions.map((v) =>
          this.prisma.adVersion.update({ where: { id: v.id }, data: { metaCreativeId: creativeIds.get(v.id), metaAdId: adIds.get(v.id), status: 'IN_REVIEW', reviewFeedback: null } }),
        ),
      ]);
    } catch (error) {
      for (const id of made.reverse()) {
        await this.ads.deleteObject(token, id).catch((e: unknown) => this.logger.warn({ id, err: e instanceof Error ? e.message : String(e) }, 'Could not delete a Meta object after a failed launch'));
      }
      throw error;
    }
  }

  /** Sends edited rejected versions back to review as new creatives on the same ads (FR-013). */
  async resubmit(campaignId: string, access: AdsAccess): Promise<number> {
    const c = await this.load(campaignId);
    const edited = c.versions.filter((v) => v.status === 'REJECTED' && !v.metaCreativeId && v.metaAdId);
    for (const v of edited) await this.upload(v, access);
    const fresh = (await this.load(campaignId)).versions.filter((v) => edited.some((e) => e.id === v.id));
    const linkUrl = adLinkUrl(this.config.PUBLIC_LINK_BASE_URL, c.linkCode);
    for (const v of fresh) {
      const creativeId = await this.ads.create(access.token, access.row.adAccountId, 'adcreatives', await this.creative(c, v, access, c.welcomeSequenceId, linkUrl));
      await this.ads.update(access.token, v.metaAdId!, { creative: { creative_id: creativeId } });
      await this.prisma.adVersion.update({ where: { id: v.id }, data: { metaCreativeId: creativeId, status: 'IN_REVIEW', reviewFeedback: null } });
    }
    return fresh.length;
  }

  private load(id: string): Promise<Campaign> {
    return this.prisma.adCampaign.findUniqueOrThrow({
      where: { id },
      include: { versions: { orderBy: { position: 'asc' }, include: { mediaAsset: true } }, number: true, leadForm: true },
    });
  }

  /** Images give a hash; videos an id once Meta has processed them (R4). Uploaded media is reused. */
  private async upload(v: Version, access: AdsAccess): Promise<void> {
    if (v.mediaKind === 'IMAGE' ? v.metaImageHash : v.metaVideoId) return;
    const bytes = await this.storage.getBuffer(v.mediaAsset.storageKey);
    const extension = v.mediaAsset.mimeType.split('/')[1] ?? 'bin';
    const filename = v.mediaAsset.displayName ?? `ad-${v.position}.${extension}`;
    if (v.mediaKind === 'IMAGE') {
      const hash = await this.ads.uploadImage(access.token, access.row.adAccountId, bytes, filename, v.mediaAsset.mimeType);
      await this.prisma.adVersion.update({ where: { id: v.id }, data: { metaImageHash: hash } });
      return;
    }
    const videoId = await this.ads.uploadVideo(access.token, access.row.adAccountId, bytes, filename, v.mediaAsset.mimeType);
    for (let i = 0; i < AdLauncher.videoTries; i += 1) {
      const status = await this.ads.videoStatus(access.token, videoId);
      if (status === 'ready') {
        await this.prisma.adVersion.update({ where: { id: v.id }, data: { metaVideoId: videoId } });
        return;
      }
      if (status === 'error') throw new Error(`Meta could not process the video of version ${v.position}`);
      await new Promise((resolve) => setTimeout(resolve, AdLauncher.videoWaitMs));
    }
    throw new Error(`Meta is still processing the video of version ${v.position}; submit again in a few minutes`);
  }

  private async creative(c: Campaign, v: Version, access: AdsAccess, sequenceId: string | null, linkUrl: string | null): Promise<Record<string, unknown>> {
    const link = c.goal === 'CHATS' ? WHATSAPP_LINK : c.goal === 'LEADS' ? LEAD_LINK : linkUrl;
    const value = c.goal === 'CHATS' ? { app_destination: 'WHATSAPP', link } : c.goal === 'LEADS' ? { lead_gen_form_id: c.leadForm?.metaFormId, link } : { link };
    const callToAction = { type: v.callToAction, value };
    const story =
      v.mediaKind === 'IMAGE'
        ? { page_id: access.row.pageId, link_data: { message: v.primaryText, name: v.headline, link, image_hash: v.metaImageHash, call_to_action: callToAction } }
        : {
            page_id: access.row.pageId,
            video_data: { message: v.primaryText, title: v.headline, video_id: v.metaVideoId, image_url: await this.ads.videoThumbnail(access.token, v.metaVideoId!), call_to_action: callToAction },
          };
    return {
      name: `${c.name} - version ${v.position}`,
      object_story_spec: story,
      ...(c.goal === 'CHATS' && sequenceId ? { asset_feed_spec: { additional_data: { partner_app_welcome_message_flow_id: sequenceId } } } : {}),
    };
  }

  private campaignSpec(c: Campaign): Record<string, unknown> {
    const special = SPECIAL[c.specialCategory];
    const countries = ((c.targeting as unknown as AdTargeting).locations ?? []).map((l) => l.countryCode ?? (l.type === 'country' ? l.key : null)).filter((x): x is string => Boolean(x));
    return {
      name: c.name,
      objective: OBJECTIVE[c.goal],
      special_ad_categories: special ? [special] : [],
      ...(special ? { special_ad_category_country: [...new Set(countries)] } : {}),
      // Budgets live on the one ad set (R3).
      is_adset_budget_sharing_enabled: false,
      status: 'ACTIVE',
    };
  }

  private async adsetSpec(c: Campaign, metaCampaignId: string, access: AdsAccess, now: Date): Promise<Record<string, unknown>> {
    const targeting = c.targeting as unknown as AdTargeting;
    const ids = [...(targeting.includeAudienceIds ?? []), ...(targeting.excludeAudienceIds ?? [])];
    const audiences = ids.length ? await this.prisma.adAudience.findMany({ where: { id: { in: ids } }, select: { id: true, metaAudienceId: true } }) : [];
    const metaId = (id: string) => audiences.find((a) => a.id === id)?.metaAudienceId ?? null;
    const include = (targeting.includeAudienceIds ?? []).map(metaId).filter((x): x is string => Boolean(x));
    const exclude = (targeting.excludeAudienceIds ?? []).map(metaId).filter((x): x is string => Boolean(x));
    const goal =
      c.goal === 'CHATS'
        ? { destination_type: 'WHATSAPP', optimization_goal: 'CONVERSATIONS', promoted_object: { page_id: access.row.pageId, whatsapp_phone_number: `+${c.number!.displayPhoneNumber.replace(/\D/g, '')}` } }
        : c.goal === 'LEADS'
          ? { destination_type: 'ON_AD', optimization_goal: 'LEAD_GENERATION', promoted_object: { page_id: access.row.pageId } }
          : { destination_type: 'WEBSITE', optimization_goal: 'LINK_CLICKS' };
    return {
      name: c.name,
      campaign_id: metaCampaignId,
      daily_budget: Number(c.dailyBudgetMinor),
      start_time: (c.startAt < now ? now : c.startAt).toISOString(),
      ...(c.endAt ? { end_time: c.endAt.toISOString() } : {}),
      billing_event: 'IMPRESSIONS',
      bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
      targeting: metaTargeting(targeting, c.placements as unknown as AdPlacements, { include, exclude }),
      status: 'ACTIVE',
      ...goal,
    };
  }
}
