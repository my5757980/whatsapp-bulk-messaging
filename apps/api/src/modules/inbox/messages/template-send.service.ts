import { HttpStatus, Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { chatTemplateSendJob } from '../../sending/send-jobs.js';
import { assertConsent, assertTemplateApproved, assertTemplateParams, HEADER_MEDIA_ASSET_PARAM, refuse } from '../../sending/template-send-rules.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { ITEM_INCLUDE, toItemDto, type ChatItemDto } from '../conversations/conversation-views.js';
import type { Viewer } from '../conversations/visibility.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';

/** POST /inbox/conversations/{id}/template (contracts/inbox-api.openapi.yaml). */
export const SendTemplateSchema = z.strictObject({
  templateId: z.uuid(),
  params: z.record(z.string(), z.string().max(1024)).default({}),
  headerMediaAssetId: z.uuid().optional(),
});
export type SendTemplateInput = z.infer<typeof SendTemplateSchema>;

/**
 * Templates sent from a chat (T041, research R12): a `messages` row with origin INBOX, so cost,
 * consent checks, retries and reports work as in 001, plus a reference item in the timeline.
 * Works in Past chats too, where it restarts the conversation.
 */
@Injectable()
export class TemplateSendService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly publisher: InboxPublisher,
    private readonly queues: QueueRegistry,
  ) {}

  async send(viewer: Viewer, conversationId: string, input: SendTemplateInput): Promise<ChatItemDto> {
    const chat = await this.conversations.loadVisible(viewer, conversationId);
    if (!chat.contactId) throw refuse('VALIDATION_FAILED', 'This contact was deleted, so the chat cannot be answered');
    if (chat.number.connectionStatus !== 'CONNECTED' || !chat.number.sendingEnabled) {
      throw refuse('NUMBER_UNAVAILABLE', 'This WhatsApp number cannot send right now');
    }
    if (chat.state === 'INTERVENED' && chat.intervenedById !== viewer.id) {
      const owner = chat.intervenedBy?.name ?? 'Another member';
      throw new AppError(HttpStatus.CONFLICT, 'ALREADY_TAKEN', `${owner} has taken this chat`, [{ field: 'intervenedBy', issue: owner }]);
    }

    const [template, contact, number] = await Promise.all([
      this.prisma.template.findUnique({ where: { id: input.templateId } }),
      this.prisma.contact.findUniqueOrThrow({ where: { id: chat.contactId }, select: { phoneE164: true, countryCode: true, consentStatus: true } }),
      this.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: chat.numberId }, select: { wabaId: true } }),
    ]);
    if (!template || template.status === 'DELETED' || template.wabaId !== number.wabaId) {
      throw new AppError(HttpStatus.NOT_FOUND, 'TEMPLATE_NOT_FOUND', 'No such template for this chat’s WhatsApp number');
    }
    assertTemplateApproved(template);
    if (input.headerMediaAssetId) {
      const asset = await this.prisma.mediaAsset.findUnique({ where: { id: input.headerMediaAssetId }, select: { purpose: true } });
      if (!asset || asset.purpose !== 'LIBRARY') throw refuse('PARAMS_MISMATCH', 'Choose the header file from the media library', [{ field: 'headerMediaAssetId', issue: 'is not a library file' }]);
    }
    assertTemplateParams(template, input.params, Boolean(input.headerMediaAssetId), 'headerMediaAssetId');
    assertConsent(contact.consentStatus, template.category);

    // Sending takes the chat, like a reply (FR-020).
    if (chat.state !== 'INTERVENED') await this.conversations.take(viewer, chat);

    const now = new Date();
    const itemId = uuidv7();
    const resolvedParams = { ...input.params, ...(input.headerMediaAssetId ? { [HEADER_MEDIA_ASSET_PARAM]: input.headerMediaAssetId } : {}) };
    const message = await this.prisma.$transaction(async (tx) => {
      const created = await tx.message.create({
        data: {
          origin: 'INBOX',
          contactId: chat.contactId,
          phoneE164: contact.phoneE164,
          recipientCountry: contact.countryCode,
          numberId: chat.numberId,
          templateId: template.id,
          resolvedParams: resolvedParams as Prisma.InputJsonValue,
          status: 'QUEUED',
          queuedAt: now,
          sentByUserId: viewer.id,
        },
      });
      await tx.messageEvent.create({ data: { messageId: created.id, type: 'QUEUED', occurredAt: now, dedupeKey: `${created.id}:queued` } });
      await tx.chatMessage.create({
        data: { id: itemId, conversationId, kind: 'MESSAGE_REF', origin: 'MEMBER', contentType: 'TEMPLATE', messageId: created.id, sentByUserId: viewer.id, occurredAt: now },
      });
      await tx.$executeRaw`
        UPDATE conversations
           SET last_activity_at = GREATEST(last_activity_at, ${now}),
               last_message_preview = ${`Template: ${template.name}`.slice(0, 120)},
               updated_at = now()
         WHERE id = ${conversationId}::uuid`;
      const opening = await tx.conversationOpening.findFirst({ where: { conversationId }, orderBy: { openedAt: 'desc' }, select: { id: true } });
      if (opening) {
        await tx.conversationOpening.updateMany({ where: { id: opening.id, firstHumanReplyAt: null }, data: { firstHumanReplyAt: now, firstResponderId: viewer.id } });
      }
      return created;
    });

    try {
      const job = chatTemplateSendJob(message.id);
      await this.queues.sendQueue(chat.numberId).add(job.name, job.data, job.opts);
    } catch (error) {
      await this.prisma.message.update({ where: { id: message.id }, data: { status: 'FAILED', failureReason: 'queue_unavailable', failedAt: new Date() } });
      await this.publisher.itemCreated(itemId);
      throw error;
    }

    await this.publisher.itemCreated(itemId);
    await this.publisher.conversation(conversationId);
    return toItemDto(await this.prisma.chatMessage.findUniqueOrThrow({ where: { id: itemId }, include: ITEM_INCLUDE }));
  }
}
