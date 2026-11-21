import { Body, Controller, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { ConversationsService } from '../../inbox/conversations/conversations.service.js';
import type { Viewer } from '../../inbox/conversations/visibility.js';
import { isLive } from '../../inbox/conversations/window.js';
import { AiConversationsService } from '../../ai/turns/ai-conversations.service.js';
import { FlowSessionService } from '../engine/session.service.js';

const StartFlowSchema = z.strictObject({ flowId: z.uuid() });
type StartFlowInput = z.infer<typeof StartFlowSchema>;

const viewer = (user: RequestUser): Viewer => ({ id: user.id, role: user.role });
const refuse = (code: string, message: string) => new AppError(HttpStatus.CONFLICT, code, message);

/**
 * Flows from live chat (003 T043, FR-031): the flows a member may start for a chat, starting one
 * (started by MEMBER; a running session ends as INTERRUPTED), and the session answering the chat.
 * The 002 visibility rules apply: only members who may see the chat get here.
 */
@Controller('inbox/conversations')
export class FlowStartController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly sessions: FlowSessionService,
    private readonly ai: AiConversationsService,
  ) {}

  /** Published flows that serve the chat's number. */
  @Get(':id/flows')
  @Require('inbox.reply')
  async flows(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    const chat = await this.conversations.loadVisible(viewer(user), id);
    return this.prisma.flow.findMany({
      where: { status: 'PUBLISHED', deletedAt: null, OR: [{ allNumbers: true }, { numbers: { some: { numberId: chat.numberId } } }] },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  @Post(':id/flows')
  @HttpCode(201)
  @Require('inbox.reply')
  async start(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(StartFlowSchema)) body: StartFlowInput) {
    const chat = await this.conversations.loadVisible(viewer(user), id);
    const flow = await this.prisma.flow.findFirst({
      where: { id: body.flowId, deletedAt: null },
      select: { id: true, status: true, publishedVersionId: true, allNumbers: true, numbers: { where: { numberId: chat.numberId }, select: { numberId: true } } },
    });
    if (!flow) throw AppError.notFound('Flow not found');
    if (flow.status !== 'PUBLISHED' || !flow.publishedVersionId || (!flow.allNumbers && !flow.numbers.length)) {
      throw refuse('FLOW_NOT_PUBLISHED', "This flow is not published for this chat's number");
    }
    if (!chat.contactId || !chat.contact) throw AppError.validation('This contact was deleted, so no flow can start');
    if (chat.contact.blockedAt) throw refuse('CONTACT_BLOCKED', 'This contact is blocked');
    const consent = await this.prisma.contact.findUnique({ where: { id: chat.contactId }, select: { consentStatus: true } });
    if (consent?.consentStatus === 'OPTED_OUT') throw refuse('CONTACT_OPTED_OUT', 'This contact has opted out of messages');
    // Flow messages are free-form, so they need the customer's 24-hour window (FR-028).
    if (!isLive(chat.lastCustomerMessageAt)) throw refuse('WINDOW_CLOSED', 'The 24-hour reply window has closed, so a flow cannot start');
    if (chat.state === 'INTERVENED' && chat.intervenedById !== user.id) throw refuse('CHAT_TAKEN_BY_OTHER', `${chat.intervenedBy?.name ?? 'Another member'} has taken this chat`);

    // A member starting a flow stops the AI agent in the chat (004 FR-026).
    await this.ai.endForConversation(chat.id, 'MEMBER_TOOK');
    const outcome = await this.sessions.start({
      flowId: flow.id,
      versionId: flow.publishedVersionId,
      conversationId: chat.id,
      startedBy: 'MEMBER',
      startedByUserId: user.id,
      replaceRunning: 'INTERRUPTED',
    });
    if (!outcome.started) throw AppError.notFound('Flow not found');
    const session = await this.sessions.describe(outcome.sessionId);
    if (!session) throw AppError.notFound('Flow session not found');
    return session;
  }

  /** The flow answering the chat, or JSON null (shown above the reply box). */
  @Get(':id/flow-session')
  @Require('inbox.view')
  async current(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    await this.conversations.loadVisible(viewer(user), id);
    res.status(200).json(await this.sessions.running(id));
  }
}
