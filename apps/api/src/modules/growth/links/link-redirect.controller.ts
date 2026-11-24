import { Controller, Get, Param, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '../../../common/auth/public.decorator.js';
import { LinkRedirectService } from './link-redirect.service.js';

/**
 * GET /l/:code (contracts/growth-api.openapi.yaml): outside the `api` prefix (app.setup.ts), with no
 * session or CSRF. Express answers HEAD requests here too; they are previews, never clicks.
 */
@Controller('l')
export class LinkRedirectController {
  constructor(private readonly links: LinkRedirectService) {}

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
