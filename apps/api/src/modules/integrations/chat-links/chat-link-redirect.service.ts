import { Injectable, Logger } from '@nestjs/common';
import { deviceKind, isLinkCode, isPreviewRequest, messageWithRef, pagePathForCount, waMeUrl } from '@wbm/shared';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { LinkRateLimiter } from '../../growth/links/link-rate-limiter.js';
import { NOT_AVAILABLE, NO_CACHE, PAGE_HEADERS, TOO_MANY, page, type LinkRequest, type LinkResponse } from '../../growth/links/link-redirect.service.js';

const NO_LONGER_IN_USE = page('This chat link is no longer in use', 'The business has turned this link off. Please ask them for a new one.');

/**
 * The public chat link route (feature 006 US7, FR-047, FR-050, research R12), with the 005 link rules:
 * the same per-client limit, no caching or referrer, and previews and robots never counted. A live link
 * sends the visitor on to WhatsApp with the pre-filled message and its reference.
 */
@Injectable()
export class ChatLinkRedirectService {
  private readonly logger = new Logger(ChatLinkRedirectService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: LinkRateLimiter,
    private readonly metrics: MetricsService,
  ) {}

  /** `widget` and `page` come from a website button's Start chat (feature 009, `?w=&p=`). */
  async open(code: string, request: LinkRequest, from: { widget?: string | undefined; page?: string | undefined } = {}): Promise<LinkResponse> {
    if (!(await this.limiter.allow(request.ip))) {
      this.metrics.chatLinkOpensTotal.inc({ kind: 'limited' });
      return { status: 429, headers: { ...PAGE_HEADERS, 'Retry-After': '60' }, body: TOO_MANY };
    }
    const link = isLinkCode(code)
      ? await this.prisma.chatLink.findUnique({
          where: { code },
          select: { id: true, message: true, ref: true, status: true, deletedAt: true, number: { select: { displayPhoneNumber: true } }, widget: { select: { key: true } } },
        })
      : null;
    if (!link) {
      this.metrics.chatLinkOpensTotal.inc({ kind: 'unknown' });
      return { status: 404, headers: PAGE_HEADERS, body: NOT_AVAILABLE };
    }
    if (link.deletedAt || link.status !== 'ACTIVE') {
      this.metrics.chatLinkOpensTotal.inc({ kind: 'off' });
      return { status: 404, headers: PAGE_HEADERS, body: NO_LONGER_IN_USE };
    }
    const preview = isPreviewRequest(request);
    this.metrics.chatLinkOpensTotal.inc({ kind: preview ? 'preview' : 'open' });
    if (!preview) {
      try {
        // The page counts only when the open comes from this link's own button (a wrong `w` is ignored).
        const fromButton = Boolean(link.widget && from.widget === link.widget.key);
        const page = fromButton ? pagePathForCount(from.page) : null;
        if (fromButton) this.metrics.widgetOpensTotal.inc();
        await this.prisma.chatLinkOpen.create({ data: { chatLinkId: link.id, device: deviceKind(request.userAgent), page } });
      } catch (error) {
        // A failed count never keeps the visitor from WhatsApp.
        this.logger.warn({ err: error, chatLinkId: link.id }, 'Could not record a chat link opening');
      }
    }
    return { status: 302, headers: { Location: waMeUrl(link.number.displayPhoneNumber, messageWithRef(link.message, link.ref)), ...NO_CACHE } };
  }
}
