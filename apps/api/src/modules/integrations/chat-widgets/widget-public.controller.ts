import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../../common/auth/public.decorator.js';
import { LinkRateLimiter } from '../../growth/links/link-rate-limiter.js';
import { ChatWidgetsService } from './chat-widgets.service.js';

// Feature 009 (research R15, contracts/website-button.md §2 - §3): the public routes of the website button,
// outside the `api` prefix (app.setup.ts) with no session: the script, a button's config and its image.

const KEY = /^[A-Za-z0-9]{12}$/;

let script: Promise<{ body: string; etag: string }> | null = null;

/** The built file (dist/widget/widget.js); outside production it is built from the source when missing. */
function widgetScript(): Promise<{ body: string; etag: string }> {
  script ??= (async () => {
    let body: string;
    try {
      body = await readFile(new URL('../../../widget/widget.js', import.meta.url), 'utf8');
    } catch (error) {
      if (process.env.NODE_ENV === 'production') throw error;
      // @ts-expect-error - the plain .mjs build script has no types
      const { buildWidget } = (await import('../../../../scripts/build-widget.mjs')) as { buildWidget: () => Promise<string> };
      body = await buildWidget();
    }
    return { body, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"` };
  })().catch((error: unknown) => {
    script = null;
    throw error;
  });
  return script;
}

@Controller('l/w')
export class WidgetPublicController {
  constructor(
    private readonly widgets: ChatWidgetsService,
    private readonly limiter: LinkRateLimiter,
  ) {}

  @Public()
  @Get('widget.js')
  async script(@Req() req: Request, @Res() res: Response): Promise<void> {
    const { body, etag } = await widgetScript();
    res.set({ 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=86400', ETag: etag, 'Access-Control-Allow-Origin': '*' });
    if (req.get('if-none-match') === etag) res.status(304).end();
    else res.status(200).send(body);
  }

  @Public()
  @Get(':key/config.json')
  async config(@Param('key') key: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    res.set({ 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
    if (!(await this.limiter.allow(req.ip))) {
      res.status(429).set('Retry-After', '60').json({ error: 'Too many requests' });
      return;
    }
    const found = KEY.test(key) ? await this.widgets.publicConfig(key) : null;
    if (!found) {
      res.status(404).json({ error: 'Unknown button' });
      return;
    }
    const etag = `"${found.version}"`;
    res.set({ 'Cache-Control': 'public, max-age=60', ETag: etag });
    if (req.get('if-none-match') === etag) res.status(304).end();
    else res.status(200).json(found.body);
  }

  @Public()
  @Get(':key/image')
  async image(@Param('key') key: string, @Res() res: Response): Promise<void> {
    const image = KEY.test(key) ? await this.widgets.image(key) : null;
    if (!image) {
      res.status(404).set('Access-Control-Allow-Origin', '*').json({ error: 'No image' });
      return;
    }
    res.status(200).set({ 'Content-Type': image.mimeType, 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' }).send(image.bytes);
  }
}
