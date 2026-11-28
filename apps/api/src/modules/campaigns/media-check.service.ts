import { Inject, Injectable, Logger } from '@nestjs/common';
import { HEADER_MEDIA_KEY, MEDIA_CHECK_MAX, cardMediaProblem, mediaResponseProblem, mediaUrlFormatProblem, type MediaUrlProblem } from '@wbm/shared';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { AppError } from '../../common/errors/app-error.js';
import { SafeHttpError, safeRequest } from '../../common/http/safe-http.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Campaign, Template, WhatsAppNumber } from '../../generated/prisma/client.js';
import { MediaService } from '../media/media.service.js';
import type { VariableMapping } from './variable-resolver.js';

// Feature 009 (research R6, R9; contracts/templates-growth-api.openapi.yaml MediaCheck): before launch,
// carousel card files must fit the template and be uploaded to the sending number, and media addresses
// must be secure, public, reachable and of the header's type and size (all up to 1,000 distinct ones,
// a random sample above that).

export interface MediaCheckResult {
  checked: number;
  sampled: boolean;
  problems: Array<{ url: string; rows?: number[]; reason: MediaUrlProblem }>;
  cardMedia: Array<{ cardIndex: number; result: 'READY' | 'WRONG_TYPE' | 'TOO_LARGE' | 'UPLOAD_FAILED'; detail?: string }>;
}

type CheckCampaign = Pick<Campaign, 'id' | 'variableMapping' | 'cardMedia' | 'audienceType'> & { template: Template | null; number: WhatsAppNumber | null };

const CONCURRENCY = 5;
const TIMEOUT_MS = 5_000;
const PROBLEMS_SHOWN = 50;

@Injectable()
export class MediaCheckService {
  private readonly logger = new Logger(MediaCheckService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** POST /campaigns/{id}/media-check. */
  async checkById(campaignId: string): Promise<MediaCheckResult> {
    const campaign = await this.prisma.campaign.findUnique({ where: { id: campaignId }, include: { template: true, number: true } });
    if (!campaign) throw AppError.notFound('Campaign not found');
    if (campaign.state !== 'DRAFT' && campaign.state !== 'SCHEDULED') throw AppError.conflict('Only draft and scheduled campaigns are checked', 'NOT_DRAFT');
    return this.check(campaign);
  }

  /** Launch: refuses with MEDIA_PROBLEMS while any problem remains. */
  async assertReady(campaign: CheckCampaign): Promise<void> {
    const result = await this.check(campaign);
    const cards = result.cardMedia.filter((c) => c.result !== 'READY');
    if (!result.problems.length && !cards.length) return;
    throw AppError.validation(
      'Some media cannot be sent',
      [
        ...cards.map((c) => ({ field: `cardMedia.${c.cardIndex}`, issue: c.detail ?? c.result })),
        ...result.problems.map((p) => ({ field: HEADER_MEDIA_KEY, issue: `${p.reason}: ${p.url}${p.rows?.length ? ` (rows ${p.rows.slice(0, 5).join(', ')})` : ''}` })),
      ],
      'MEDIA_PROBLEMS',
    );
  }

  async check(campaign: CheckCampaign): Promise<MediaCheckResult> {
    const result: MediaCheckResult = { checked: 0, sampled: false, problems: [], cardMedia: [] };
    if (campaign.template?.kind === 'CAROUSEL' && campaign.number) result.cardMedia = await this.checkCards(campaign.template, (campaign.cardMedia ?? null) as Array<{ cardIndex: number; mediaAssetId: string }> | null, campaign.number);
    const mapping = (campaign.variableMapping ?? {}) as VariableMapping;
    const source = mapping[HEADER_MEDIA_KEY];
    const format = this.headerFormat(campaign.template);
    if (source && format) Object.assign(result, await this.checkAddresses(campaign.id, source, format));
    return result;
  }

  /** Each card's file fits the card format and is uploaded to the number (cached by the 001 media service). */
  private async checkCards(template: Template, chosen: Array<{ cardIndex: number; mediaAssetId: string }> | null, number: WhatsAppNumber): Promise<MediaCheckResult['cardMedia']> {
    const components = (Array.isArray(template.components) ? template.components : []) as Array<{ type: string; cards?: Array<{ components?: Array<{ type: string; format?: string }> }> }>;
    const cards = components.find((c) => c.type.toUpperCase() === 'CAROUSEL')?.cards ?? [];
    const samples = ((template.options ?? {}) as { cards?: Array<{ sampleMediaAssetId?: string | null }> }).cards ?? [];
    const out: MediaCheckResult['cardMedia'] = [];
    for (const [i, card] of cards.entries()) {
      const format = (card.components ?? []).find((p) => p.type.toUpperCase() === 'HEADER')?.format?.toUpperCase() === 'VIDEO' ? 'VIDEO' : 'IMAGE';
      const assetId = chosen?.find((c) => c.cardIndex === i)?.mediaAssetId ?? samples[i]?.sampleMediaAssetId ?? null;
      const asset = assetId ? await this.prisma.mediaAsset.findUnique({ where: { id: assetId } }) : null;
      if (!asset) {
        out.push({ cardIndex: i, result: 'UPLOAD_FAILED', detail: 'choose a file for this card' });
        continue;
      }
      const problem = cardMediaProblem(format, { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes });
      if (problem) {
        out.push({ cardIndex: i, result: problem, detail: problem === 'WRONG_TYPE' ? `use ${format === 'IMAGE' ? 'a JPEG or PNG image' : 'an MP4 video'}` : 'the file is too large' });
        continue;
      }
      try {
        await this.media.ensureMetaMediaId(asset.id, number);
        out.push({ cardIndex: i, result: 'READY' });
      } catch (error) {
        this.logger.warn({ cardIndex: i, err: (error as Error).message }, 'Card media upload failed');
        out.push({ cardIndex: i, result: 'UPLOAD_FAILED', detail: 'WhatsApp did not take the file; try another one' });
      }
    }
    return out;
  }

  /** Local runs and tests only (OUTBOUND_ALLOW_LOCAL, never production): http://localhost files, like webhooks and stores. */
  private localTestAddress(url: string): boolean {
    if (!this.config.OUTBOUND_ALLOW_LOCAL || process.env.NODE_ENV === 'production') return false;
    try {
      const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
      return host === 'localhost' || host === '127.0.0.1' || host === '::1';
    } catch {
      return false;
    }
  }

  private headerFormat(template: Template | null): 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null {
    const components = (Array.isArray(template?.components) ? template!.components : []) as Array<{ type: string; format?: string }>;
    const format = components.find((c) => c.type.toUpperCase() === 'HEADER')?.format?.toUpperCase();
    return format === 'IMAGE' || format === 'VIDEO' || format === 'DOCUMENT' ? format : null;
  }

  /** The distinct addresses of the campaign (one value, or an upload column), checked 5 at a time. */
  private async checkAddresses(campaignId: string, source: { source: string; value?: string; key?: string }, format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'): Promise<Pick<MediaCheckResult, 'checked' | 'sampled' | 'problems'>> {
    const rowsByUrl = new Map<string, number[]>();
    if (source.source === 'static') rowsByUrl.set((source.value ?? '').trim(), []);
    else if (source.source === 'column') {
      const rows = await this.prisma.campaignUploadRow.findMany({ where: { campaignId }, select: { rowNumber: true, data: true }, orderBy: { rowNumber: 'asc' } });
      for (const row of rows) {
        const url = String(((row.data ?? {}) as Record<string, unknown>)[source.key ?? ''] ?? '').trim();
        if (url) rowsByUrl.set(url, [...(rowsByUrl.get(url) ?? []), row.rowNumber]);
      }
    } else return { checked: 0, sampled: false, problems: [] }; // attribute addresses are checked when sent
    let urls = [...rowsByUrl.keys()];
    const sampled = urls.length > MEDIA_CHECK_MAX;
    if (sampled) urls = urls.sort(() => Math.random() - 0.5).slice(0, MEDIA_CHECK_MAX);
    const problems: MediaCheckResult['problems'] = [];
    let next = 0;
    const worker = async () => {
      while (next < urls.length) {
        const url = urls[next++]!;
        const reason = await this.checkOne(url, format);
        if (reason && problems.length < PROBLEMS_SHOWN) problems.push({ url, rows: rowsByUrl.get(url) ?? [], reason });
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, urls.length) }, worker));
    return { checked: urls.length, sampled, problems };
  }

  /** One address through the safe client (https and public addresses only, up to 3 redirects): HEAD, or a one-byte ranged GET when HEAD is refused. */
  private async checkOne(url: string, format: 'IMAGE' | 'VIDEO' | 'DOCUMENT'): Promise<MediaUrlProblem | null> {
    if (mediaUrlFormatProblem(url) && !this.localTestAddress(url)) return 'NOT_HTTPS';
    const ask = (method: 'HEAD' | 'GET') =>
      safeRequest({ method, url, ...(method === 'GET' ? { headers: { range: 'bytes=0-0' } } : {}), timeoutMs: TIMEOUT_MS, maxBytes: 1024, onLimit: 'truncate', followRedirects: 3, allowLocal: this.config.OUTBOUND_ALLOW_LOCAL });
    try {
      let res = await ask('HEAD');
      if (res.status === 405 || res.status === 501 || res.status === 403) res = await ask('GET');
      if (res.status >= 400) return 'UNREACHABLE';
      const type = String(res.headers['content-type'] ?? '');
      const range = /\/(\d+)$/.exec(String(res.headers['content-range'] ?? ''));
      const length = range ? Number(range[1]) : res.headers['content-length'] && res.status === 200 ? Number(res.headers['content-length']) : null;
      return mediaResponseProblem(format, type, length);
    } catch (error) {
      if (error instanceof SafeHttpError) {
        if (error.reason === 'BLOCKED_ADDRESS') return 'NOT_PUBLIC';
        if (error.reason === 'TIMEOUT') return 'TIMEOUT';
        if (error.reason === 'NOT_HTTPS' || error.reason === 'BAD_URL') return 'NOT_HTTPS';
      }
      return 'UNREACHABLE';
    }
  }
}
