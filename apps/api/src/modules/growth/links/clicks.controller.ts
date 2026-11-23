import { Controller, Get, Param, ParseUUIDPipe, Query, Req, Res } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Response } from 'express';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { PageQuerySchema, type PageQuery } from '../../../common/validation/pagination.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AuditService } from '../../audit/audit.service.js';
import { csvField } from '../../campaigns/csv.js';
import { ClicksService } from './clicks.service.js';

const COLUMNS = ['phone', 'name', 'clicks', 'first_click_at', 'last_click_at'];
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'campaign';

/** Click results of a campaign (contracts/growth-api.openapi.yaml, tag clicks). */
@Controller('campaigns')
export class ClicksController {
  constructor(
    private readonly clicks: ClicksService,
    private readonly audit: AuditService,
  ) {}

  @Get(':id/clicks/summary')
  @Require('campaigns.view')
  summary(@Param('id', ParseUUIDPipe) id: string) {
    return this.clicks.summary(id);
  }

  @Get(':id/clicks')
  @Require('campaigns.view')
  list(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(PageQuerySchema)) query: PageQuery) {
    return this.clicks.clickers(id, query);
  }

  /** The Clicked view as CSV, streamed in batches; audited like 001 exports. */
  @Get(':id/clicks/export')
  @Require('data.export')
  async export(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const campaign = await this.clicks.assertCampaign(id);
    await this.audit.record({ userId: user.id, ip: clientIp(req) ?? null }, 'data.exported', { type: 'campaign', id }, { view: 'clicked', format: 'csv' });
    const fullPhones = can(user.role, 'phones.full');

    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="clicked-${slug(campaign.name)}-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(`${COLUMNS.join(',')}\n`);
    for await (const batch of this.clicks.batches(id)) {
      const chunk = batch
        .map((r) => [fullPhones ? (r.phone ?? '') : (maskPhone(r.phone) ?? ''), r.name ?? '', r.clicks, r.firstClickAt, r.lastClickAt].map(csvField).join(','))
        .join('\n');
      if (!res.write(`${chunk}\n`)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }
}
