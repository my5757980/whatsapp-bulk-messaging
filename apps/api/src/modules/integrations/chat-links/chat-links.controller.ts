import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Req, Res } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Response } from 'express';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../../common/auth/request-user.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { PageQuerySchema, type PageQuery } from '../../../common/validation/pagination.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AuditService } from '../../audit/audit.service.js';
import { csvField } from '../../campaigns/csv.js';
import {
  ChatLinkCreateSchema,
  ChatLinkPatchSchema,
  ChatLinkResultsQuerySchema,
  ChatLinksService,
  QrQuerySchema,
  TagContactsSchema,
  slug,
  type ChatLinkCreate,
  type ChatLinkPatch,
  type ChatLinkResultsQuery,
  type QrQuery,
} from './chat-links.service.js';

const NEWLINE = '\n';

/** Chat links and QR codes (feature 006 US7, contracts/integrations-api.openapi.yaml tag chat-links). */
@Controller('chat-links')
export class ChatLinksController {
  constructor(
    private readonly links: ChatLinksService,
    private readonly audit: AuditService,
  ) {}

  private actor(user: RequestUser, req: AuthedRequest) {
    return { userId: user.id, ip: clientIp(req) ?? null };
  }

  @Get()
  @Require('campaigns.view')
  list() {
    return this.links.list();
  }

  @Post()
  @Require('campaigns.manage')
  create(@Body(new ZodValidationPipe(ChatLinkCreateSchema)) body: ChatLinkCreate, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.links.create(body, this.actor(user, req));
  }

  @Get(':id')
  @Require('campaigns.view')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.links.get(id);
  }

  @Patch(':id')
  @Require('campaigns.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(ChatLinkPatchSchema)) body: ChatLinkPatch, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.links.update(id, body, this.actor(user, req));
  }

  @Delete(':id')
  @HttpCode(204)
  @Require('campaigns.manage')
  async remove(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest): Promise<void> {
    await this.links.remove(id, this.actor(user, req));
  }

  /** The QR image, shown inline in the dashboard and saved with the link's name. */
  @Get(':id/qr')
  @Require('campaigns.view')
  async qr(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(QrQuerySchema)) query: QrQuery, @Res() res: Response): Promise<void> {
    const image = await this.links.qr(id, query);
    res
      .status(200)
      .set({ 'content-type': image.contentType, 'content-disposition': `inline; filename="${image.filename}"`, 'cache-control': 'private, max-age=300' })
      .send(image.body);
  }

  @Get(':id/results')
  @Require('campaigns.view')
  results(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(ChatLinkResultsQuerySchema)) query: ChatLinkResultsQuery) {
    return this.links.results(id, query);
  }

  @Get(':id/contacts')
  @Require('campaigns.view')
  contacts(@Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(PageQuerySchema)) query: PageQuery, @CurrentUser() user: RequestUser) {
    return this.links.contacts(id, query, can(user.role, 'phones.full'));
  }

  /** The contacts who started chats as CSV; audited like 001 exports, phones masked without phones.full. */
  @Get(':id/contacts/export')
  @Require('data.export')
  async export(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const link = await this.links.assertExists(id);
    await this.audit.record(this.actor(user, req), 'data.exported', { type: 'chat_link', id }, { view: 'chat link contacts', format: 'csv' });
    const fullPhones = can(user.role, 'phones.full');
    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="chat-link-${slug(link.name)}-contacts.csv"`);
    res.write(`phone,name,first_started_at,last_started_at,chats_started${NEWLINE}`);
    for await (const page of this.links.exportRows(id)) {
      const chunk = page
        .map((r) => [fullPhones ? r.phone : (maskPhone(r.phone) ?? ''), r.name ?? '', r.firstStartedAt.toISOString(), r.lastStartedAt.toISOString(), r.starts].map(csvField).join(','))
        .join(NEWLINE);
      if (!res.write(`${chunk}${NEWLINE}`)) await new Promise((resolve) => res.once('drain', resolve));
    }
    res.end();
  }

  @Post(':id/contacts/tag')
  @HttpCode(200)
  @Require('campaigns.manage')
  tag(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(TagContactsSchema)) body: { tag: string }, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.links.tagContacts(id, body.tag, this.actor(user, req));
  }
}
