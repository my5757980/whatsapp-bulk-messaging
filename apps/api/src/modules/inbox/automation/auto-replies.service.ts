import { Inject, Injectable, Logger } from '@nestjs/common';
import { checkChatMedia } from '@wbm/shared';
import type { Redis } from 'ioredis';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry, REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { resolveVariables, VariableMappingSchema } from '../../campaigns/variable-resolver.js';
import { chatTemplateSendJob, requestSendWorkerSync, sessionSendJob } from '../../sending/send-jobs.js';
import { previewOf } from '../inbound/message-parser.js';
import type { ChatContentType } from '../inbox-common.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';
import { LiveChatSettingsService, type AutoContent } from '../settings/live-chat-settings.service.js';
import { decideAutoReply, type AutoReplyKind } from './auto-replies.js';
import { isWithinHours } from './working-hours.js';
import { GlobalAttributesService } from '../../settings/global-attributes.service.js';

/** One off-hours message per contact every 12 hours (FR-035). */
const OFF_HOURS_GAP_SECONDS = 12 * 3600;

export interface AutoReplyInput {
  conversationId: string;
  contactId: string;
  newOpening: boolean;
  /** The customer message was an opt-out, opt-in or "talk to a person" keyword. */
  keyword: boolean;
}

/**
 * Welcome and off-hours messages (T080, FR-035, FR-036, research R10). Called by the inbound
 * pipeline after consent and keyword handling. Each is sent at most once (welcome per opening,
 * off-hours per contact per 12 h), labelled automatic, and never counted as a member's response.
 */
@Injectable()
export class AutoRepliesService {
  private readonly logger = new Logger(AutoRepliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: LiveChatSettingsService,
    private readonly publisher: InboxPublisher,
    private readonly queues: QueueRegistry,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly globals: GlobalAttributesService,
  ) {}

  async handle(input: AutoReplyInput): Promise<AutoReplyKind | null> {
    const s = await this.settings.get();
    if (!s.welcomeEnabled && !s.offHoursEnabled) return null;
    const contact = await this.prisma.contact.findUnique({
      where: { id: input.contactId },
      select: { name: true, phoneE164: true, attributes: true, consentStatus: true, countryCode: true, blockedAt: true },
    });
    if (!contact) return null;
    const kind = decideAutoReply({
      welcomeEnabled: s.welcomeEnabled,
      offHoursEnabled: s.offHoursEnabled,
      withinHours: isWithinHours(s.workingHours, s.timezone),
      newOpening: input.newOpening,
      keyword: input.keyword,
      blocked: contact.blockedAt !== null,
      optedOut: contact.consentStatus === 'OPTED_OUT',
    });
    const content = kind === 'welcome' ? s.welcomeContent : kind === 'off_hours' ? s.offHoursContent : null;
    if (!kind || !content) return null;

    // Claim before sending, so repeated or concurrent webhooks send it once (SC-004).
    if (kind === 'welcome') {
      const opening = await this.prisma.conversationOpening.findFirst({ where: { conversationId: input.conversationId }, orderBy: { openedAt: 'desc' }, select: { id: true } });
      if (!opening) return null;
      const claimed = await this.prisma.conversationOpening.updateMany({ where: { id: opening.id, welcomeSentAt: null }, data: { welcomeSentAt: new Date() } });
      if (!claimed.count) return null;
    } else if (!(await this.redis.set(`wbm:offhours:${input.contactId}`, '1', 'EX', OFF_HOURS_GAP_SECONDS, 'NX'))) {
      return null;
    }

    try {
      await this.send(input.conversationId, content, contact);
      return kind;
    } catch (error) {
      this.logger.warn({ err: (error as Error).message, conversationId: input.conversationId, kind }, 'Automatic message not sent');
      return null;
    }
  }

  /** A plain automatic text in a chat, e.g. the answer to a COD button (feature 006 US5). */
  async sendText(conversationId: string, text: string): Promise<void> {
    const chat = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { contact: { select: { name: true, phoneE164: true, attributes: true, consentStatus: true, countryCode: true } } },
    });
    if (!chat.contact) return;
    await this.send(conversationId, { kind: 'TEXT', text }, chat.contact);
  }

  /** Feature 010 (US4): a keyword reply in a chat; `extraParams` ride along on a template message. */
  async sendContent(conversationId: string, content: NonNullable<AutoContent>, extraParams: Record<string, string> = {}): Promise<void> {
    const chat = await this.prisma.conversation.findUniqueOrThrow({
      where: { id: conversationId },
      select: { contact: { select: { name: true, phoneE164: true, attributes: true, consentStatus: true, countryCode: true } } },
    });
    if (!chat.contact) return;
    await this.send(conversationId, content, chat.contact, extraParams);
  }

  private async send(
    conversationId: string,
    content: NonNullable<AutoContent>,
    contact: { name: string | null; phoneE164: string; attributes: unknown; consentStatus: string; countryCode: string },
    extraParams: Record<string, string> = {},
  ): Promise<void> {
    const chat = await this.prisma.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { numberId: true, contactId: true } });
    const now = new Date();
    const itemId = uuidv7();

    if (content.kind === 'TEMPLATE') {
      const template = await this.prisma.template.findUnique({ where: { id: content.templateId } });
      if (!template || template.status !== 'APPROVED') throw new Error('The automatic message template is not approved');
      if (template.category === 'MARKETING' && contact.consentStatus !== 'OPTED_IN') throw new Error('Marketing template needs an opt-in');
      const mapping = VariableMappingSchema.safeParse(content.variables ?? {});
      const variables = (Array.isArray(template.variables) ? template.variables : []) as Array<{ key: string }>;
      const resolved = resolveVariables(variables, mapping.success ? mapping.data : {}, { contact: { name: contact.name, phone: contact.phoneE164, attributes: contact.attributes }, row: {}, globals: await this.globals.values() });
      if (!resolved.ok) throw new Error(`Template variables without a value or fallback: ${resolved.missing.join(', ')}`);
      const message = await this.prisma.$transaction(async (tx) => {
        const created = await tx.message.create({
          data: {
            origin: 'INBOX',
            automatic: true,
            contactId: chat.contactId,
            phoneE164: contact.phoneE164,
            recipientCountry: contact.countryCode,
            numberId: chat.numberId,
            templateId: template.id,
            resolvedParams: { ...resolved.params, ...extraParams } as Prisma.InputJsonValue,
            status: 'QUEUED',
            queuedAt: now,
          },
        });
        await tx.messageEvent.create({ data: { messageId: created.id, type: 'QUEUED', occurredAt: now, dedupeKey: `${created.id}:queued` } });
        await tx.chatMessage.create({ data: { id: itemId, conversationId, kind: 'MESSAGE_REF', origin: 'AUTOMATIC', contentType: 'TEMPLATE', messageId: created.id, occurredAt: now } });
        await this.touch(tx, conversationId, now, `Template: ${template.name}`);
        return created;
      });
      const job = chatTemplateSendJob(message.id);
      await this.queues.sendQueue(chat.numberId).add(job.name, job.data, job.opts);
    } else {
      let contentType: ChatContentType = 'TEXT';
      let text: string | null = content.text?.trim() || null;
      let mediaAssetId: string | null = null;
      let payload: Record<string, unknown> = {};
      if (content.kind !== 'TEXT') {
        const asset = await this.prisma.mediaAsset.findUnique({ where: { id: content.mediaAssetId } });
        const check = asset ? checkChatMedia(asset.mimeType, asset.sizeBytes) : null;
        if (!asset || asset.purpose !== 'LIBRARY' || asset.removedAt || !check?.ok) throw new Error('The automatic message file is not available');
        contentType = check.kind === 'image' ? 'IMAGE' : check.kind === 'video' ? 'VIDEO' : check.kind === 'audio' ? 'AUDIO' : 'DOCUMENT';
        mediaAssetId = asset.id;
        payload = { mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, ...(contentType === 'DOCUMENT' ? { fileName: asset.displayName ?? 'document' } : {}) };
        if (contentType === 'AUDIO') text = null;
      }
      await this.prisma.$transaction(async (tx) => {
        await tx.chatMessage.create({
          data: { id: itemId, conversationId, kind: 'SESSION_OUT', origin: 'AUTOMATIC', contentType, text, mediaAssetId, payload: payload as Prisma.InputJsonValue, status: 'QUEUED', occurredAt: now },
        });
        await this.touch(tx, conversationId, now, previewOf({ contentType, text, payload }));
      });
      const job = sessionSendJob(itemId);
      await this.queues.sendQueue(chat.numberId).add(job.name, job.data, job.opts);
    }
    await requestSendWorkerSync(this.queues);
    await this.publisher.itemCreated(itemId);
    await this.publisher.conversation(conversationId);
  }

  private async touch(tx: Prisma.TransactionClient, conversationId: string, at: Date, preview: string): Promise<void> {
    await tx.$executeRaw`
      UPDATE conversations
         SET last_activity_at = GREATEST(last_activity_at, ${at}), last_message_preview = ${preview.slice(0, 120)}, updated_at = now()
       WHERE id = ${conversationId}::uuid`;
  }
}
