import { Controller, Get, Injectable, Logger, Param, Req, Res } from '@nestjs/common';
import { deviceKind, isLinkCode, isPreviewRequest, withCampaignTags } from '@wbm/shared';
import type { Request, Response } from 'express';
import { Public } from '../../../common/auth/public.decorator.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { LinkRateLimiter } from '../../growth/links/link-rate-limiter.js';
import { NOT_AVAILABLE, NO_CACHE, PAGE_HEADERS, TOO_MANY, page, type LinkRequest, type LinkResponse } from '../../growth/links/link-redirect.service.js';

const ENDED = page('This offer has ended', 'The ad this link came from is no longer running.');

/**
 * Website ad links (feature 007 US8, FR-040, research R10) with the 005 link rules: the same per-client
 * limit, no caching or referrer, previews and robots never counted. A visit is counted per open and the
 * visitor goes on to the ad's web page with utm_source=meta, utm_medium=paid and the campaign's name.
 */
@Injectable()
export class AdLinkRedirectService {
  private readonly logger = new Logger(AdLinkRedirectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: LinkRateLimiter,
  ) {}

  async open(code: string, request: LinkRequest): Promise<LinkResponse> {
    if (!(await this.limiter.allow(request.ip))) return { status: 429, headers: { ...PAGE_HEADERS, 'Retry-After': '60' }, body: TOO_MANY };
    const campaign = isLinkCode(code)
      ? await this.prisma.adCampaign.findUnique({ where: { linkCode: code }, select: { id: true, name: true, websiteUrl: true, status: true, deletedAt: true } })
      : null;
    if (!campaign?.websiteUrl || campaign.deletedAt) return { status: 404, headers: PAGE_HEADERS, body: NOT_AVAILABLE };
    if (campaign.status === 'ENDED') return { status: 404, headers: PAGE_HEADERS, body: ENDED };
    if (!isPreviewRequest(request)) {
      try {
        await this.prisma.adLinkOpen.create({ data: { adCampaignId: campaign.id, device: deviceKind(request.userAgent) } });
      } catch (error) {
        // A failed count never keeps the visitor from the page.
        this.logger.warn({ err: error, adCampaignId: campaign.id }, 'Could not record an ad link visit');
      }
    }
    return { status: 302, headers: { Location: withCampaignTags(campaign.websiteUrl, campaign.name, 'meta', 'paid'), ...NO_CACHE } };
  }
}

/** GET /l/a/:code (contracts/ads-api.openapi.yaml): outside the `api` prefix (app.setup.ts), with no session or CSRF. */
@Controller('l/a')
export class AdLinkRedirectController {
  constructor(private readonly links: AdLinkRedirectService) {}

  @Public()
  @Get(':code')
  async open(@Param('code') code: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.links.open(code, {
      method: req.method,
      userAgent: req.get('user-agent'),
      purpose: req.get('purpose'),
      secPurpose: req.get('sec-purpose'),
      ip: req.ip,
    });
    res.status(result.status).set(result.headers);
    if (result.body !== undefined) res.send(result.body);
    else res.end();
  }
}
