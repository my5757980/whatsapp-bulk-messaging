import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { StorageService } from '../../common/storage/storage.service.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';

/**
 * Deletes a contact's personal data (FR-015, T103): the contact, its tags, consent events and
 * uploaded rows are removed; linked messages keep status and country but lose the contact id,
 * phone and resolved variables, so campaign totals stay correct.
 *
 * Live chat (002 FR-042, T096): the contact's chats stay, without contact, preview, item text,
 * payloads or media; the customer's own media files are deleted, library files are kept; journey
 * entries lose attribute values; in-app alerts about these chats are removed. Openings and counts
 * stay for the team view.
 */
@Injectable()
export class ContactDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
  ) {}

  async delete(contactId: string, actor: AuditActor): Promise<void> {
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, phoneE164: true, countryCode: true } });
    if (!contact) throw AppError.notFound('Contact not found');

    const chatIds = (await this.prisma.conversation.findMany({ where: { contactId }, select: { id: true } })).map((c) => c.id);
    const customerMedia = chatIds.length
      ? await this.prisma.mediaAsset.findMany({ where: { purpose: 'INBOUND', chatMessages: { some: { conversationId: { in: chatIds } } } }, select: { id: true, storageKey: true } })
      : [];

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
      this.prisma.contact.delete({ where: { id: contactId } }),
    ]);
    // Files after the commit; one that cannot be deleted now is left for the retention job.
    for (const media of customerMedia) await this.storage.delete(media.storageKey).catch(() => undefined);
    await this.audit.record(actor, 'contact.deleted', { type: 'contact', id: contactId }, {
      country: contact.countryCode,
      messagesAnonymised: messages.count,
      chatsErased: chatIds.length,
    });
  }
}
