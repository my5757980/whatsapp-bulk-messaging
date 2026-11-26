import { Controller, Get, Injectable, Logger, Param, Query, Req, Res } from '@nestjs/common';
import { isLinkCode, isPreviewRequest } from '@wbm/shared';
import type { Request, Response } from 'express';
import { Public } from '../../../common/auth/public.decorator.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { LinkRateLimiter } from '../../growth/links/link-rate-limiter.js';
import { NOT_AVAILABLE, NO_CACHE, PAGE_HEADERS, TOO_MANY, type LinkRequest } from '../../growth/links/link-redirect.service.js';
import { PaymentSessions } from '../requests/payment-sessions.js';

// The pay link (feature 008 US2, research R2, contracts/commerce-api.openapi.yaml GET /l/p/{code}):
// the customer goes on to Stripe's page for a waiting request; paid, expired, cancelled and paused
// requests and Stripe's return get our own pages with a way back to the chat. The 005 link rules
// apply: the same per-client limit, no caching or referrer, previews and robots never counted.

interface PayLinkResponse {
  status: 200 | 302 | 404 | 429;
  headers: Record<string, string>;
  body?: string;
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function payPage(title: string, text: string, chatUrl: string | null): string {
  const back = chatUrl ? `<p><a href="${escape(chatUrl)}" style="display:inline-block;padding:.6rem 1rem;border-radius:.5rem;background:#128c7e;color:#fff;text-decoration:none">Back to WhatsApp</a></p>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escape(title)}</title></head><body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 15vh auto; padding: 0 1rem; color: #222"><h1 style="font-size: 1.25rem">${escape(title)}</h1><p>${escape(text)}</p>${back}</body></html>`;
}

@Injectable()
export class PayLinkService {
  private readonly logger = new Logger(PayLinkService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: LinkRateLimiter,
    private readonly sessions: PaymentSessions,
  ) {}

  async open(code: string, request: LinkRequest, returned: boolean): Promise<PayLinkResponse> {
    if (!(await this.limiter.allow(request.ip))) return { status: 429, headers: { ...PAGE_HEADERS, 'Retry-After': '60' }, body: TOO_MANY };
    const row = isLinkCode(code)
      ? await this.prisma.paymentRequest.findUnique({ where: { code }, select: { id: true, conversation: { select: { number: { select: { displayPhoneNumber: true } } } } } })
      : null;
    if (!row) return { status: 404, headers: PAGE_HEADERS, body: NOT_AVAILABLE };
    const digits = row.conversation?.number.displayPhoneNumber.replace(/\D/g, '') ?? '';
    const chatUrl = digits ? `https://wa.me/${digits}` : null;
    const html = (title: string, text: string): PayLinkResponse => ({ status: 200, headers: PAGE_HEADERS, body: payPage(title, text, chatUrl) });

    if (returned) return html('Thank you', 'Your payment is being confirmed. You can go back to WhatsApp now.');
    const preview = isPreviewRequest(request);
    if (!preview) {
      try {
        await this.prisma.$executeRaw`UPDATE payment_requests SET opens = opens + 1, first_opened_at = COALESCE(first_opened_at, now()) WHERE id = ${row.id}::uuid`;
      } catch (error) {
        // A failed count never keeps the customer from paying.
        this.logger.warn({ err: error, paymentRequestId: row.id }, 'Could not count a pay link open');
      }
    }
    const result = await this.sessions.ensureOpen(row.id, new Date(), { create: !preview });
    if ('url' in result) return { status: 302, headers: { Location: result.url, ...NO_CACHE } };
    switch (result.page) {
      case 'PAID':
        return html('Payment received', 'Thank you, this payment is complete. You can go back to WhatsApp.');
      case 'EXPIRED':
        return html('This payment link has expired', 'Ask us in WhatsApp for a new link.');
      case 'CANCELLED':
        return html('This payment request was cancelled', 'Ask us in WhatsApp if you still want to pay.');
      case 'PREVIEW':
        return html('Payment link', 'Open this link on your phone to pay securely with Stripe.');
      default:
        return html('Payments are paused', 'We cannot take payments right now. Please try again later.');
    }
  }
}

/** GET /l/p/:code: outside the `api` prefix (app.setup.ts), with no session or CSRF. */
@Controller('l/p')
export class PayLinkController {
  constructor(private readonly links: PayLinkService) {}

  @Public()
  @Get(':code')
  async open(@Param('code') code: string, @Query('paid') paid: string | undefined, @Req() req: Request, @Res() res: Response): Promise<void> {
    const result = await this.links.open(
      code,
      { method: req.method, userAgent: req.get('user-agent'), purpose: req.get('purpose'), secPurpose: req.get('sec-purpose'), ip: req.ip },
      paid === '1',
    );
    res.status(result.status).set(result.headers);
    if (result.body !== undefined) res.send(result.body);
    else res.end();
  }
}
