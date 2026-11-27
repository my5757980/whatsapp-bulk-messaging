import { HttpStatus, Injectable } from '@nestjs/common';
import { checkChatMedia, type ChatMediaKind } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { requestSendWorkerSync, sessionSendJob } from '../../sending/send-jobs.js';
import { renderCanned } from '../canned/canned-render.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ITEM_INCLUDE, toItemDto, type ChatItemDto, type ConversationRow } from '../conversations/conversation-views.js';
import type { Viewer } from '../conversations/visibility.js';
import { isLive } from '../conversations/window.js';
import { previewOf } from '../inbound/message-parser.js';
import type { ChatContentType } from '../inbox-common.js';
import { MediaLibraryService } from '../media-library/media-library.service.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';
import { AiConversationsService } from '../../ai/turns/ai-conversations.service.js';
import { FlowSessionService } from '../../flows/engine/session.service.js';

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
    if (value.type === 'media' && Boolean(value.mediaAssetId) === Boolean(value.mediaUrl)) {
      ctx.addIssue({ code: 'custom', path: ['mediaAssetId'], message: 'choose either a library file or a link' });
    }
    if (value.type === 'canned' && !value.cannedMessageId) ctx.addIssue({ code: 'custom', path: ['cannedMessageId'], message: 'is required' });
  });
export type SendMessageInput = z.infer<typeof SendMessageSchema>;

/** What will be sent: a text, or a file with an optional caption (data-model §3 payloads). */
export interface Outgoing {
  contentType: ChatContentType;
  text: string | null;
  mediaAssetId: string | null;
  payload: Record<string, unknown>;
}

const CONTENT_BY_KIND: Record<ChatMediaKind, ChatContentType> = { image: 'IMAGE', video: 'VIDEO', audio: 'AUDIO', document: 'DOCUMENT' };

/** Kind of a public link, from its file extension; anything unknown goes as a document. */
function kindOfLink(url: string): ChatMediaKind {
  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? '';
  if (['jpg', 'jpeg', 'png'].includes(ext)) return 'image';
  if (['mp4', '3gp', '3gpp'].includes(ext)) return 'video';
  if (['mp3', 'ogg', 'opus', 'aac', 'amr', 'm4a'].includes(ext)) return 'audio';
  return 'document';
}

/**
 * Free-form replies inside the 24-hour window (T031, T065; FR-010-FR-015, FR-018, FR-020, R3):
 * text, a media library file or https link with a caption, or a saved reply with its variables
 * filled in. Stored as QUEUED and sent through the number's send queue at priority 1.
 */
@Injectable()
export class SessionSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly publisher: InboxPublisher,
    private readonly queues: QueueRegistry,
    private readonly library: MediaLibraryService,
    private readonly flows: FlowSessionService,
    private readonly ai: AiConversationsService,
  ) {}

  async send(viewer: Viewer, conversationId: string, input: SendMessageInput): Promise<ChatItemDto> {
    const chat = await this.prepare(viewer, conversationId);
    return this.deliver(viewer, chat, await this.resolve(chat, input));
  }

  /**
   * The checks of a member reply: the chat is visible, the contact exists, the number can send and
   * nobody else has taken the chat; the 24-hour window too unless `requireWindow` is false (feature
   * 008 decides between a session message and a template itself).
   */
  async prepare(viewer: Viewer, conversationId: string, opts: { requireWindow?: boolean } = {}): Promise<ConversationRow> {
    const chat = await this.conversations.loadVisible(viewer, conversationId);
    if (!chat.contact?.phoneE164) throw AppError.validation('This contact was deleted, so the chat cannot be answered');
    if ((opts.requireWindow ?? true) && !isLive(chat.lastCustomerMessageAt)) {
      throw AppError.validation('The 24-hour reply window has closed. Send a template instead.', [], 'WINDOW_CLOSED');
    }
    if (chat.number.connectionStatus !== 'CONNECTED' || !chat.number.sendingEnabled) {
      throw AppError.validation('This WhatsApp number cannot send right now', [], 'NUMBER_UNAVAILABLE');
    }
    if (chat.state === 'INTERVENED' && chat.intervenedById !== viewer.id) {
      const owner = chat.intervenedBy?.name ?? 'Another member';
      throw new AppError(HttpStatus.CONFLICT, 'ALREADY_TAKEN', `${owner} has taken this chat`, [{ field: 'intervenedBy', issue: owner }]);
    }
    return chat;
  }

  /** Feature 008: a prepared session message (a Pay now message, products, a form) sent like a member reply. */
  async sendPrepared(viewer: Viewer, chat: ConversationRow, outgoing: Outgoing): Promise<ChatItemDto> {
    if (!isLive(chat.lastCustomerMessageAt)) throw AppError.validation('The 24-hour reply window has closed. Send a template instead.', [], 'WINDOW_CLOSED');
    return this.deliver(viewer, chat, outgoing);
  }

  private async deliver(viewer: Viewer, chat: ConversationRow, outgoing: Outgoing): Promise<ChatItemDto> {
    const conversationId = chat.id;
    // A member's reply stops the flow answering the chat, also one the member started (003 FR-026),
    // and the AI agent; a reply it is preparing is not sent (004 FR-026).
    await this.flows.stopForConversation(conversationId);
    await this.ai.endForConversation(conversationId, 'MEMBER_TOOK');
    // Replying takes the chat, so every reply has an owner (FR-020).
    if (chat.state !== 'INTERVENED') await this.conversations.take(viewer, chat);

    const id = uuidv7();
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.chatMessage.create({
        data: {
          id,
          conversationId,
          kind: 'SESSION_OUT',
          origin: 'MEMBER',
          contentType: outgoing.contentType,
          text: outgoing.text,
          payload: outgoing.payload as Prisma.InputJsonValue,
          mediaAssetId: outgoing.mediaAssetId,
          status: 'QUEUED',
          sentByUserId: viewer.id,
          occurredAt: now,
        },
      });
      await tx.$executeRaw`
        UPDATE conversations
           SET last_activity_at = GREATEST(last_activity_at, ${now}),
               last_message_preview = ${previewOf(outgoing)},
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
      await requestSendWorkerSync(this.queues);
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

  /** Turns the request into the message to send, applying the chat media limits (FR-015). */
  private async resolve(chat: ConversationRow, input: SendMessageInput): Promise<Outgoing> {
    if (input.type === 'text') return { contentType: 'TEXT', text: input.text!.trim(), mediaAssetId: null, payload: {} };
    if (input.type === 'media') return this.media(input.mediaAssetId, input.mediaUrl, input.text, input.fileName);

    const canned = await this.prisma.cannedMessage.findUnique({ where: { id: input.cannedMessageId! } });
    if (!canned) throw AppError.notFound('Saved reply not found');
    const contact = { name: chat.contact?.name ?? null, phoneE164: chat.contact?.phoneE164 ?? null, attributes: (chat.contact?.attributes ?? {}) as Record<string, unknown> };
    const rendered = renderCanned(canned.text ?? '', contact, (canned.variableFallbacks ?? {}) as Record<string, string>, input.params ?? {});
    if (!rendered.ok) {
      throw AppError.validation('Fill in every parameter of the saved reply', rendered.missing.map((n) => ({ field: `params.${n}`, issue: 'is required' })), 'PARAMS_MISSING');
    }
    if (canned.type === 'TEXT') return { contentType: 'TEXT', text: rendered.text, mediaAssetId: null, payload: {} };
    return this.media(canned.mediaAssetId ?? undefined, canned.mediaUrl ?? undefined, rendered.text, canned.fileName ?? undefined);
  }

  private async media(assetId: string | undefined, url: string | undefined, caption: string | undefined, fileName: string | undefined): Promise<Outgoing> {
    let kind: ChatMediaKind;
    let payload: Record<string, unknown>;
    if (assetId) {
      const asset = await this.library.usable(assetId);
      const check = checkChatMedia(asset.mimeType, asset.sizeBytes);
      if (!check.ok) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, check.code, check.message);
      kind = check.kind;
      payload = { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes };
      if (kind === 'document') payload.fileName = fileName ?? asset.displayName ?? 'document';
    } else if (url) {
      kind = kindOfLink(url);
      payload = { link: url, ...(kind === 'document' ? { fileName: fileName ?? (new URL(url).pathname.split('/').pop() || 'document') } : {}) };
    } else {
      throw AppError.validation('Choose a library file or an https link', [{ field: 'mediaAssetId', issue: 'is required' }]);
    }
    // Voice notes and audio files carry no caption on WhatsApp.
    const text = kind === 'audio' ? null : caption?.trim() || null;
    return { contentType: CONTENT_BY_KIND[kind], text, mediaAssetId: assetId ?? null, payload };
  }
}
