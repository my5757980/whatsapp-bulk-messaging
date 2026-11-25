import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { PlatformEvents } from '../integrations/webhooks/platform-events.js';

/**
 * Deletes a contact's personal data (FR-015, T103): the contact, its tags, consent events and
 * uploaded rows are removed; linked messages keep status and country but lose the contact id,
 * phone and resolved variables, so campaign totals stay correct.
 *
 * Live chat (002 FR-042, T096): the contact's chats stay, without contact, preview, item text,
 * payloads or media; the customer's own media files are deleted, library files are kept; journey
 * entries lose attribute values; in-app alerts about these chats are removed. Openings and counts
 * stay for the team view.
 *
 * AI agent (004 FR-051): AI conversations lose the contact, summary and pending confirmation, the
 * customer's unanswered asks are deleted; AI reply records keep only counts and sources.
 *
 * Campaign growth (005 FR-040): the contact leaves every drip with the reason DELETED; enrolments,
 * clicks and tracked links lose the contact (foreign keys set it to null) and stay as anonymous
 * counts; starting events not consumed yet are deleted.
 */
@Injectable()
export class ContactDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly platformEvents: PlatformEvents,
  ) {}

  async delete(contactId: string, actor: AuditActor): Promise<void> {
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, phoneE164: true, countryCode: true } });
    if (!contact) throw AppError.notFound('Contact not found');

    const chatIds = (await this.prisma.conversation.findMany({ where: { contactId }, select: { id: true } })).map((c) => c.id);
    const aiConversationIds = (
      await this.prisma.aiConversation.findMany({ where: { OR: [{ contactId }, { conversationId: { in: chatIds } }] }, select: { id: true } })
    ).map((c) => c.id);
    const questionIds = aiConversationIds.length
      ? (await this.prisma.aiUnansweredAsk.findMany({ where: { aiConversationId: { in: aiConversationIds } }, select: { questionId: true }, distinct: ['questionId'] })).map((a) => a.questionId)
      : [];
    const customerMedia = chatIds.length
      ? await this.prisma.mediaAsset.findMany({ where: { purpose: 'INBOUND', chatMessages: { some: { conversationId: { in: chatIds } } } }, select: { id: true, storageKey: true } })
      : [];

    // Store orders and carts keep their rows without the person's details (feature 006, FR-060).
    await this.prisma.$transaction([
      this.prisma.storeCart.updateMany({ where: { contactId, status: { in: ['OPEN', 'REMINDING'] } }, data: { status: 'STOPPED', stopReason: 'deleted', nextAt: null } }),
      this.prisma.storeCart.updateMany({ where: { contactId }, data: { phoneE164: null } }),
      this.prisma.storeOrder.updateMany({ where: { contactId, codStatus: { in: ['ASKED', 'NO_ANSWER'] } }, data: { codStatus: 'CLOSED', codNextAt: null } }),
      this.prisma.storeOrder.updateMany({ where: { contactId }, data: { phoneE164: null, customerName: null } }),
    ]);
    const [messages] = await this.prisma.$transaction([
      this.prisma.message.updateMany({ where: { contactId }, data: { contactId: null, phoneE164: null, resolvedParams: {} } }),
      this.prisma.campaignUploadRow.deleteMany({ where: { phoneE164: contact.phoneE164 } }),
      this.prisma.chatMessage.updateMany({ where: { conversationId: { in: chatIds } }, data: { text: null, payload: {}, mediaAssetId: null } }),
      this.prisma.mediaAsset.deleteMany({ where: { id: { in: customerMedia.map((m) => m.id) }, purpose: 'INBOUND' } }),
      this.prisma.conversation.updateMany({ where: { id: { in: chatIds } }, data: { lastMessagePreview: null } }),
      this.prisma.$executeRaw`
        UPDATE conversation_events SET data = jsonb_build_object('key', data->'key')
         WHERE type = 'ATTRIBUTE_CHANGED' AND conversation_id = ANY(${chatIds}::uuid[])`,
      this.prisma.notification.deleteMany({ where: { link: { in: chatIds.map((id) => `/inbox?c=${id}`) } } }),
      // Flow answers are what the customer typed (003 T083); sessions stay for analytics without them.
      this.prisma.flowSession.updateMany({ where: { contactId }, data: { answers: {}, contactId: null } }),
      // AI agent (004 FR-051): their unanswered asks go (a question only they asked goes too, shared
      // counts follow); AI conversations lose the contact, summary and pending confirmation; reply
      // records keep only counts and sources; remembered values go with the contact's attributes.
      this.prisma.aiUnansweredAsk.deleteMany({ where: { aiConversationId: { in: aiConversationIds } } }),
      this.prisma.$executeRaw`
        UPDATE ai_unanswered_questions q SET ask_count = (SELECT count(*)::int FROM ai_unanswered_asks a WHERE a.question_id = q.id)
         WHERE q.id = ANY(${questionIds}::uuid[])`,
      this.prisma.aiUnansweredQuestion.deleteMany({ where: { id: { in: questionIds }, askCount: 0 } }),
      this.prisma.aiConversation.updateMany({
        where: { id: { in: aiConversationIds } },
        data: { contactId: null, summary: null, pendingConfirmation: Prisma.DbNull, unansweredStreak: Prisma.DbNull },
      }),
      // Campaign growth (005 FR-040): the contact leaves every drip; enrolments, clicks and tracked
      // links lose the contact through their foreign keys and keep only anonymous counts.
      this.prisma.$executeRaw`
        UPDATE drip_enrolments SET status = 'LEFT', left_reason = 'DELETED', ended_at = now(), next_due_at = NULL
         WHERE contact_id = ${contactId}::uuid AND status = 'ACTIVE'`,
      this.prisma.dripEvent.deleteMany({ where: { contactId } }),
      this.prisma.contact.delete({ where: { id: contactId } }),
    ]);
    // Outbound webhooks (feature 006, FR-060): waiting events about them are cancelled, stored events
    // keep only their id, and endpoints are told the contact was deleted (with the id only).
    await this.prisma.$executeRaw`
      UPDATE webhook_deliveries SET status = 'CANCELLED', next_attempt_at = NULL, updated_at = now()
       WHERE status = 'PENDING' AND event_id IN (SELECT id FROM outbound_events WHERE data->'contact'->>'id' = ${contactId})`;
    await this.prisma.$executeRaw`
      UPDATE outbound_events
         SET data = (data - 'text' - 'caption' - 'buttonPayload') || jsonb_build_object('contact', jsonb_build_object('id', ${contactId}::text))
       WHERE data->'contact'->>'id' = ${contactId}`;
    await this.platformEvents.contactDeleted(this.prisma, contactId);
    // Files after the commit; one that cannot be deleted now is left for the retention job.
    for (const media of customerMedia) await this.storage.delete(media.storageKey).catch(() => undefined);
    await this.audit.record(actor, 'contact.deleted', { type: 'contact', id: contactId }, {
      country: contact.countryCode,
      messagesAnonymised: messages.count,
      chatsErased: chatIds.length,
    });
  }
}
