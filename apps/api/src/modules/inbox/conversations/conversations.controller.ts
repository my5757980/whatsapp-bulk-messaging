import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Res } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Response } from 'express';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { DEFAULT_PHONE_FIELDS, maskPhoneFields } from '../../../common/interceptors/phone-mask.interceptor.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { ChatItemsService, ItemsQuerySchema, type ItemsQuery } from '../messages/chat-items.service.js';
import { SendMessageSchema, SessionSendService, type SendMessageInput } from '../messages/session-send.service.js';
import { SendTemplateSchema, TemplateSendService, type SendTemplateInput } from '../messages/template-send.service.js';
import {
  ConversationListQuerySchema,
  ConversationsService,
  OpenConversationSchema,
  type ConversationListQuery,
  type OpenConversationInput,
} from './conversations.service.js';
import type { Viewer } from './visibility.js';

const viewer = (user: RequestUser): Viewer => ({ id: user.id, role: user.role });

/** Live chat lists and actions (T034, contracts/inbox-api.openapi.yaml). Phones are masked for agents globally. */
@Controller('inbox')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly items: ChatItemsService,
    private readonly sender: SessionSendService,
    private readonly templates: TemplateSendService,
  ) {}

  /** 200 with the existing chat, 201 when it was created. */
  @Post('conversations')
  @Require('inbox.reply')
  async open(
    @CurrentUser() user: RequestUser,
    @Body(new ZodValidationPipe(OpenConversationSchema)) body: OpenConversationInput,
    @Res() res: Response,
  ): Promise<void> {
    const { created, summary } = await this.conversations.openOrCreate(viewer(user), body);
    // @Res() bypasses the global phone-mask interceptor, so agents are masked here (FR-029).
    const out = can(user.role, 'phones.full') ? summary : maskPhoneFields(summary, new Set(DEFAULT_PHONE_FIELDS));
    res.status(created ? 201 : 200).json(out);
  }

  @Get('conversations')
  @Require('inbox.view')
  list(@CurrentUser() user: RequestUser, @Query(new ZodValidationPipe(ConversationListQuerySchema)) query: ConversationListQuery) {
    return this.conversations.list(viewer(user), query);
  }

  @Get('conversations/:id')
  @Require('inbox.view')
  detail(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.detail(viewer(user), id);
  }

  @Get('conversations/:id/items')
  @Require('inbox.view')
  timeline(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Query(new ZodValidationPipe(ItemsQuerySchema)) query: ItemsQuery) {
    return this.items.list(viewer(user), id, query);
  }

  @Post('conversations/:id/intervene')
  @HttpCode(200)
  @Require('inbox.reply')
  intervene(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.intervene(viewer(user), id);
  }

  @Post('conversations/:id/resolve')
  @HttpCode(200)
  @Require('inbox.reply')
  resolve(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.conversations.resolve(viewer(user), id);
  }

  @Post('conversations/:id/messages')
  @HttpCode(202)
  @Require('inbox.reply')
  send(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SendMessageSchema)) body: SendMessageInput) {
    return this.sender.send(viewer(user), id, body);
  }

  @Post('conversations/:id/template')
  @HttpCode(202)
  @Require('inbox.reply')
  template(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(SendTemplateSchema)) body: SendTemplateInput) {
    return this.templates.send(viewer(user), id, body);
  }

  @Post('conversations/:id/read')
  @HttpCode(204)
  @Require('inbox.view')
  async read(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.conversations.markRead(viewer(user), id);
  }

  @Get('numbers')
  @Require('inbox.reply')
  numbers() {
    return this.conversations.numbers();
  }

  @Get('unread')
  @Require('inbox.view')
  unread(@CurrentUser() user: RequestUser) {
    return this.conversations.unreadTotal(viewer(user));
  }
}
