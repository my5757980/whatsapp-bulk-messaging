import { Injectable, Logger } from '@nestjs/common';
import { deviceKind, isLinkCode, isPreviewRequest } from '@wbm/shared';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { ClickRecorder } from './click-recorder.js';
import { LinkRateLimiter } from './link-rate-limiter.js';
import { LinkResolver } from './link-resolver.js';

export interface LinkRequest {
  method: string;
  userAgent?: string | undefined;
  purpose?: string | undefined;
  secPurpose?: string | undefined;
  /** Used only for the rate limit, as a salted hash; never stored with a click (FR-003). */
  ip?: string | undefined;
}

export interface LinkResponse {
  status: 302 | 404 | 429;
  headers: Record<string, string>;
  body?: string;
}

const NO_CACHE = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' };
const PAGE_HEADERS = {
  ...NO_CACHE,
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
  'X-Robots-Tag': 'noindex',
};

function page(title: string, text: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title></head><body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 15vh auto; padding: 0 1rem; color: #222"><h1 style="font-size: 1.25rem">${title}</h1><p>${text}</p></body></html>`;
}

const NOT_AVAILABLE = page('This link is not available', 'The link may be mistyped or no longer in use. Please check the message you received.');
const TOO_MANY = page('Please try again shortly', 'Too many links were opened from this connection. Please wait a minute and try again.');

/**
 * The public tracked-link route (FR-003 - FR-005): send the visitor on at once, count real clicks
 * only, and never send anyone onward from an unknown code.
 */
@Injectable()
export class LinkRedirectService {
  private readonly logger = new Logger(LinkRedirectService.name);

  constructor(
    private readonly resolver: LinkResolver,
    private readonly recorder: ClickRecorder,
    private readonly limiter: LinkRateLimiter,
    private readonly metrics: MetricsService,
  ) {}

  async open(code: string, request: LinkRequest): Promise<LinkResponse> {
    const done = this.metrics.linkRedirectDuration.startTimer();
    try {
      return await this.answer(code, request);
    } finally {
      done();
    }
  }

  private async answer(code: string, request: LinkRequest): Promise<LinkResponse> {
    if (!(await this.limiter.allow(request.ip))) {
      this.metrics.linkClicksTotal.inc({ kind: 'limited' });
      return { status: 429, headers: { ...PAGE_HEADERS, 'Retry-After': '60' }, body: TOO_MANY };
    }
    const link = isLinkCode(code) ? await this.resolver.resolve(code) : null;
    if (!link) {
      this.metrics.linkClicksTotal.inc({ kind: 'unknown' });
      return { status: 404, headers: PAGE_HEADERS, body: NOT_AVAILABLE };
    }

    const preview = isPreviewRequest(request);
    this.metrics.linkClicksTotal.inc({ kind: preview ? 'preview' : 'click' });
    if (!preview) {
      try {
        await this.recorder.record(link, deviceKind(request.userAgent));
      } catch (error) {
        // A failed click record never keeps the visitor from the destination.
        this.logger.warn({ err: error, linkId: link.linkId }, 'Could not record a link click');
      }
    }
    return { status: 302, headers: { Location: link.destination, ...NO_CACHE } };
  }
}
