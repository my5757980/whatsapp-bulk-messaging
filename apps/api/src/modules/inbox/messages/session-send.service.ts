import { HttpStatus, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { sessionSendJob } from '../../sending/send-jobs.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ITEM_INCLUDE, toItemDto, type ChatItemDto } from '../conversations/conversation-views.js';
import type { Viewer } from '../conversations/visibility.js';
import { isLive } from '../conversations/window.js';
import { previewOf } from '../inbound/message-parser.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';

/** POST /inbox/conversations/{id}/messages (contracts/inbox-api.openapi.yaml). */
export const SendMessageSchema = z
  .strictObject({
    type: z.enum(['text', 'media', 'canned']),
    text: z.string().max(4096).optional(),
    mediaAssetId: z.uuid().optional(),
    mediaUrl: z.url().regex(/^https:\/\//, 'must be an https link').optional(),
    fileName: z.string().max(240).optional(),
    cannedMessageId: z.uuid().optional(),
    params: z.record(z.string(), z.string().max(1024)).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'text' && !value.text?.trim()) ctx.addIssue({ code: 'custom', path: ['text'], message: 'Write a message first' });
  });
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

/**
 * Free-form replies inside the 24-hour window (T031, FR-010-FR-014, FR-018, FR-020, research R3).
 * The reply is stored as QUEUED and goes out through the number's send queue at priority 1.
 */
@Injectable()
export class SessionSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly publisher: InboxPublisher,
    private readonly queues: QueueRegistry,
  ) {}

  async send(viewer: Viewer, conversationId: string, input: SendMessageInput): Promise<ChatItemDto> {
    if (input.type !== 'text') {
      throw AppError.validation('Sending files and saved replies is not available yet', [{ field: 'type', issue: 'use text' }]);
    }
    const text = input.text!.trim();
    const chat = await this.conversations.loadVisible(viewer, conversationId);
    if (!chat.contact?.phoneE164) throw AppError.validation('This contact was deleted, so the chat cannot be answered');
    if (!isLive(chat.lastCustomerMessageAt)) {
      throw AppError.validation('The 24-hour reply window has closed. Send a template instead.', [], 'WINDOW_CLOSED');
    }
    if (chat.number.connectionStatus !== 'CONNECTED' || !chat.number.sendingEnabled) {
      throw AppError.validation('This WhatsApp number cannot send right now', [], 'NUMBER_UNAVAILABLE');
    }
    if (chat.state === 'INTERVENED' && chat.intervenedById !== viewer.id) {
      const owner = chat.intervenedBy?.name ?? 'Another member';
      throw new AppError(HttpStatus.CONFLICT, 'ALREADY_TAKEN', `${owner} has taken this chat`, [{ field: 'intervenedBy', issue: owner }]);
    }
    // Replying takes the chat, so every reply has an owner (FR-020).
    if (chat.state !== 'INTERVENED') await this.conversations.take(viewer, chat);

    const id = uuidv7();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.chatMessage.create({
        data: { id, conversationId, kind: 'SESSION_OUT', origin: 'MEMBER', contentType: 'TEXT', text, status: 'QUEUED', sentByUserId: viewer.id, occurredAt: now },
      });
      await tx.$executeRaw`
        UPDATE conversations
           SET last_activity_at = GREATEST(last_activity_at, ${now}),
               last_message_preview = ${previewOf({ contentType: 'TEXT', text, payload: {} })},
               updated_at = now()
         WHERE id = ${conversationId}::uuid`;
      // First member reply of this opening (team metrics, R14).
      const opening = await tx.conversationOpening.findFirst({ where: { conversationId }, orderBy: { openedAt: 'desc' }, select: { id: true } });
      if (opening) {
        await tx.conversationOpening.updateMany({ where: { id: opening.id, firstHumanReplyAt: null }, data: { firstHumanReplyAt: now, firstResponderId: viewer.id } });
      }
    });

    try {
      const job = sessionSendJob(id);
      await this.queues.sendQueue(chat.numberId).add(job.name, job.data, job.opts);
    } catch (error) {
      await this.prisma.chatMessage.update({
        where: { id },
        data: { status: 'FAILED', failureReason: 'The reply could not be queued; please try again', failedAt: new Date() },
      });
      await this.publisher.itemCreated(id);
      throw error;
    }

    await this.publisher.itemCreated(id);
    await this.publisher.conversation(conversationId);
    return toItemDto(await this.prisma.chatMessage.findUniqueOrThrow({ where: { id }, include: ITEM_INCLUDE }));
  }
}
