import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { ChatItemsService, ItemsQuerySchema, type ItemsQuery } from '../messages/chat-items.service.js';
import { SendMessageSchema, SessionSendService, type SendMessageInput } from '../messages/session-send.service.js';
import { ConversationListQuerySchema, ConversationsService, type ConversationListQuery } from './conversations.service.js';
import type { Viewer } from './visibility.js';

const viewer = (user: RequestUser): Viewer => ({ id: user.id, role: user.role });

/** Live chat lists and actions (T034, contracts/inbox-api.openapi.yaml). Phones are masked for agents globally. */
@Controller('inbox')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly items: ChatItemsService,
    private readonly sender: SessionSendService,
  ) {}

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

  @Post('conversations/:id/read')
  @HttpCode(204)
  @Require('inbox.view')
  async read(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.conversations.markRead(viewer(user), id);
  }

  @Get('unread')
  @Require('inbox.view')
  unread(@CurrentUser() user: RequestUser) {
    return this.conversations.unreadTotal(viewer(user));
  }
}
