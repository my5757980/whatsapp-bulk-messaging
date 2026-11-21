import { Controller, Get, Param, ParseUUIDPipe, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { ConversationsService } from '../../inbox/conversations/conversations.service.js';
import { AiConversationsService } from '../turns/ai-conversations.service.js';

/**
 * The chat's active AI conversation for the "AI agent is answering" banner (T056, FR-020), or JSON
 * null. The 002 visibility rules apply: only members who may see the chat get here.
 */
@Controller('inbox/conversations')
export class AiStateController {
  constructor(
    private readonly conversations: ConversationsService,
    private readonly ai: AiConversationsService,
  ) {}

  @Get(':id/ai')
  @Require('inbox.view')
  async state(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.conversations.loadVisible({ id: user.id, role: user.role }, id);
    const row = await this.ai.active(id);
    res.status(200).json(
      row
        ? { id: row.id, agentId: row.agentId, agentName: row.agent.name, startedBy: row.startedBy, test: row.test, replies: row.replies, startedAt: row.startedAt.toISOString() }
        : null,
    );
  }
}
