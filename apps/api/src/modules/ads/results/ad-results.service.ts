import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { AdsConnectionService } from '../connection/ads-connection.service.js';
import { localDate } from '../sync/ads-insights.processor.js';

// Ad results (feature 007 US4, FR-026 – FR-029, research R7): Meta's numbers per day and per version
// with the platform's own counts (chats started, new contacts, contacts who replied, leads, website
// visits) and the costs per chat and lead, in the account's time zone and currency.

const DATE = /^\d{4}-\d{2}-\d{2}$/;
export const ResultsQuerySchema = z
  .object({ from: z.string().regex(DATE, 'must be a date (YYYY-MM-DD)').optional(), to: z.string().regex(DATE, 'must be a date (YYYY-MM-DD)').optional() })
  .strict();

export interface Numbers {
  impressions: number;
  reach: number;
  clicks: number;
  ctr: number | null;
  cpcMinor: number | null;
  spendMinor: number;
  metaConversations: number;
  chatsStarted: number;
  newContacts: number;
  replied: number;
  leads: number;
  visits: number;
  costPerChatMinor: number | null;
  costPerLeadMinor: number | null;
}

type Raw = Omit<Numbers, 'ctr' | 'cpcMinor' | 'costPerChatMinor' | 'costPerLeadMinor'>;
const empty = (): Raw => ({ impressions: 0, reach: 0, clicks: 0, spendMinor: 0, metaConversations: 0, chatsStarted: 0, newContacts: 0, replied: 0, leads: 0, visits: 0 });

function finish(raw: Raw): Numbers {
  return {
    ...raw,
    ctr: raw.impressions ? Math.round((raw.clicks / raw.impressions) * 10_000) / 100 : null,
    cpcMinor: raw.clicks ? Math.round(raw.spendMinor / raw.clicks) : null,
    costPerChatMinor: raw.chatsStarted ? Math.round(raw.spendMinor / raw.chatsStarted) : null,
    costPerLeadMinor: raw.leads ? Math.round(raw.spendMinor / raw.leads) : null,
  };
}

interface MetaRow {
  ad_version_id: string | null;
  day: string;
  impressions: bigint;
  reach: bigint;
  clicks: bigint;
  spend_minor: bigint;
  meta_conversations: number;
}
interface CountRow {
  ad_version_id: string | null;
  day: string;
  n: bigint;
  new_contacts?: bigint;
  replied?: bigint;
}

@Injectable()
export class AdResultsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connection: AdsConnectionService,
  ) {}

  async results(id: string, query: z.infer<typeof ResultsQuerySchema> = {}, now = new Date()) {
    const campaign = await this.prisma.adCampaign.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, currency: true, startAt: true, submittedAt: true, versions: { select: { id: true, position: true }, orderBy: { position: 'asc' } } },
    });
    if (!campaign) throw AppError.notFound('Ad campaign not found');
    const timezone = (await this.connection.access())?.row.timezone ?? 'UTC';
    const today = localDate(now, timezone);
    const started = localDate(campaign.submittedAt ?? campaign.startAt, timezone);
    const from = query.from ?? (started < today ? started : today);
    const to = query.to && query.to < today ? query.to : today;
    if (from > to) throw AppError.validation('Check the dates', [{ field: 'from', issue: 'must not be after the end date' }]);

    const [meta, chats, leads, visits, synced] = await Promise.all([
      this.prisma.$queryRaw<MetaRow[]>`
        SELECT ad_version_id, to_char(day, 'YYYY-MM-DD') AS day, impressions, reach, clicks, spend_minor, meta_conversations
          FROM ad_result_days
         WHERE ad_campaign_id = ${id}::uuid AND day BETWEEN ${from}::date AND ${to}::date`,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT s.ad_version_id, to_char((s.started_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day, count(*) AS n,
               count(*) FILTER (WHERE s.new_contact) AS new_contacts,
               count(*) FILTER (WHERE EXISTS (
                 SELECT 1 FROM chat_messages b
                  WHERE b.conversation_id = s.conversation_id AND b.kind IN ('SESSION_OUT', 'MESSAGE_REF') AND b.occurred_at >= s.started_at
                    AND EXISTS (SELECT 1 FROM chat_messages c WHERE c.conversation_id = s.conversation_id AND c.kind = 'INBOUND' AND c.occurred_at > b.occurred_at))) AS replied
          FROM ad_chat_starts s
         WHERE s.ad_campaign_id = ${id}::uuid AND (s.started_at AT TIME ZONE ${timezone})::date BETWEEN ${from}::date AND ${to}::date
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT v.id AS ad_version_id, to_char((l.submitted_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day, count(*) AS n
          FROM ad_leads l LEFT JOIN ad_versions v ON v.meta_ad_id = l.meta_ad_id
         WHERE l.ad_campaign_id = ${id}::uuid AND (l.submitted_at AT TIME ZONE ${timezone})::date BETWEEN ${from}::date AND ${to}::date
         GROUP BY 1, 2`,
      this.prisma.$queryRaw<CountRow[]>`
        SELECT NULL::uuid AS ad_version_id, to_char((opened_at AT TIME ZONE ${timezone})::date, 'YYYY-MM-DD') AS day, count(*) AS n
          FROM ad_link_opens
         WHERE ad_campaign_id = ${id}::uuid AND (opened_at AT TIME ZONE ${timezone})::date BETWEEN ${from}::date AND ${to}::date
         GROUP BY 1, 2`,
      this.prisma.adResultDay.aggregate({ where: { adCampaignId: id }, _max: { readAt: true } }),
    ]);

    const days = new Map<string, Raw>();
    const versions = new Map<string, Raw>(campaign.versions.map((v) => [v.id, empty()]));
    const day = (d: string) => days.get(d) ?? (days.set(d, empty()), days.get(d)!);
    // A day's Meta numbers come from the campaign's own row; versions from theirs.
    const hasCampaignRow = new Set(meta.filter((r) => r.ad_version_id === null).map((r) => r.day));
    for (const r of meta) {
      const n = { impressions: Number(r.impressions), reach: Number(r.reach), clicks: Number(r.clicks), spendMinor: Number(r.spend_minor), metaConversations: r.meta_conversations };
      if (r.ad_version_id === null || !hasCampaignRow.has(r.day)) {
        const d = day(r.day);
        d.impressions += n.impressions;
        d.reach = r.ad_version_id === null ? n.reach : Math.max(d.reach, n.reach);
        d.clicks += n.clicks;
        d.spendMinor += n.spendMinor;
        d.metaConversations += n.metaConversations;
      }
      const v = r.ad_version_id ? versions.get(r.ad_version_id) : undefined;
      if (v) {
        v.impressions += n.impressions;
        v.reach = Math.max(v.reach, n.reach);
        v.clicks += n.clicks;
        v.spendMinor += n.spendMinor;
        v.metaConversations += n.metaConversations;
      }
    }
    for (const r of chats) {
      for (const target of [day(r.day), r.ad_version_id ? versions.get(r.ad_version_id) : undefined]) {
        if (!target) continue;
        target.chatsStarted += Number(r.n);
        target.newContacts += Number(r.new_contacts ?? 0);
        target.replied += Number(r.replied ?? 0);
      }
    }
    for (const r of leads) {
      for (const target of [day(r.day), r.ad_version_id ? versions.get(r.ad_version_id) : undefined]) if (target) target.leads += Number(r.n);
    }
    for (const r of visits) day(r.day).visits += Number(r.n);

    const ordered = [...days.entries()].sort(([a], [b]) => a.localeCompare(b));
    const totals = ordered.reduce((sum, [, d]) => {
      for (const key of Object.keys(sum) as Array<keyof Raw>) sum[key] = key === 'reach' ? Math.max(sum.reach, d.reach) : sum[key] + d[key];
      return sum;
    }, empty());
    return {
      currency: campaign.currency,
      timezone,
      from,
      to,
      syncedAt: synced._max.readAt?.toISOString() ?? null,
      totals: finish(totals),
      days: ordered.map(([date, d]) => ({ date, ...finish(d) })),
      versions: campaign.versions.map((v) => ({ versionId: v.id, position: v.position, ...finish(versions.get(v.id)!) })),
    };
  }
}
