import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';

/**
 * Deletes a contact's personal data (FR-015, T103): the contact, its tags, consent events and
 * uploaded rows are removed; linked messages keep status and country but lose the contact id,
 * phone and resolved variables, so campaign totals stay correct.
 */
@Injectable()
export class ContactDeletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async delete(contactId: string, actor: AuditActor): Promise<void> {
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { id: true, phoneE164: true, countryCode: true } });
    if (!contact) throw AppError.notFound('Contact not found');

    const [messages] = await this.prisma.$transaction([
      this.prisma.message.updateMany({ where: { contactId }, data: { contactId: null, phoneE164: null, resolvedParams: {} } }),
      this.prisma.campaignUploadRow.deleteMany({ where: { phoneE164: contact.phoneE164 } }),
      this.prisma.contact.delete({ where: { id: contactId } }),
    ]);
    await this.audit.record(actor, 'contact.deleted', { type: 'contact', id: contactId }, {
      country: contact.countryCode,
      messagesAnonymised: messages.count,
    });
  }
}
