import { Body, Controller, Delete, Get, HttpCode, Injectable, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { ClientIp, CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AuditService } from '../../audit/audit.service.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { ContactsService } from '../../contacts/contacts.service.js';
import { JourneyService } from '../journey/journey.service.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';
import { ConversationsService } from './conversations.service.js';
import type { Viewer } from './visibility.js';

/** PATCH /inbox/conversations/{id}/contact (contracts/inbox-api.openapi.yaml). */
export const EditContactSchema = z.strictObject({
  name: z.string().trim().max(120).nullable().optional(),
  attributes: z.record(z.string(), z.unknown()).optional(),
  addTagIds: z.array(z.uuid()).max(50).optional(),
  removeTagIds: z.array(z.uuid()).max(50).optional(),
  firstMessageTagId: z.uuid().nullable().optional(),
});
export type EditContactInput = z.infer<typeof EditContactSchema>;

const viewer = (user: RequestUser): Viewer => ({ id: user.id, role: user.role });

/**
 * The contact behind a chat (US5): its profile, edits from the chat profile (recorded in the
 * journey, T072) and blocking (T073, FR-034). Blocking keeps messages but stops alerts, live
 * events and automatic replies; it never changes consent, so campaigns still reach the contact.
 */
@Injectable()
export class ChatContactService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly contacts: ContactsService,
    private readonly journey: JourneyService,
    private readonly publisher: InboxPublisher,
    private readonly audit: AuditService,
  ) {}

  async profile(contactId: string) {
    const contact = await this.prisma.contact.findUnique({
      where: { id: contactId },
      select: {
        id: true,
        name: true,
        phoneE164: true,
        leadSource: true,
        consentStatus: true,
        consentSource: true,
        consentAt: true,
        attributes: true,
        blockedAt: true,
        firstMessageTag: { select: { id: true, name: true } },
        tags: { select: { tag: { select: { id: true, name: true } } } },
      },
    });
    if (!contact) throw AppError.notFound('Contact not found');
    return {
      contactId: contact.id,
      name: contact.name,
      phone: contact.phoneE164,
      leadSource: contact.leadSource,
      firstMessageTag: contact.firstMessageTag,
      consentStatus: contact.consentStatus,
      consentSource: contact.consentSource,
      consentAt: contact.consentAt?.toISOString() ?? null,
      attributes: (contact.attributes ?? {}) as Record<string, unknown>,
      tags: contact.tags.map((t) => t.tag).sort((a, b) => a.name.localeCompare(b.name)),
      blocked: contact.blockedAt !== null,
    };
  }

  async edit(user: RequestUser, conversationId: string, input: EditContactInput) {
    const chat = await this.conversations.loadVisible(viewer(user), conversationId);
    if (!chat.contactId) throw AppError.notFound('Contact not found');
    const before = await this.profile(chat.contactId);

    const tagIds = [...new Set([...(input.addTagIds ?? []), ...(input.removeTagIds ?? []), ...(input.firstMessageTagId ? [input.firstMessageTagId] : [])])];
    const known = await this.prisma.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true, name: true } });
    const nameOf = new Map(known.map((t) => [t.id, t.name]));
    const unknown = tagIds.filter((id) => !nameOf.has(id));
    if (unknown.length) throw AppError.validation('Some tags do not exist', unknown.map((id) => ({ field: 'tags', issue: `${id} is not a tag` })));

    const current = new Set(before.tags.map((t) => t.name));
    const added = (input.addTagIds ?? []).map((id) => nameOf.get(id)!).filter((name) => !current.has(name));
    const removed = (input.removeTagIds ?? []).map((id) => nameOf.get(id)!).filter((name) => current.has(name));
    const tagsChanged = added.length > 0 || removed.length > 0;
    const nextTags = [...current].filter((name) => !removed.includes(name)).concat(added);

    // Name, attributes and tags go through the 001 rules (attribute types, tag names).
    await this.contacts.update(
      chat.contactId,
      {
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.attributes ? { attributes: input.attributes } : {}),
        ...(tagsChanged ? { tags: nextTags } : {}),
      },
      user.id,
    );
    if (input.firstMessageTagId !== undefined) {
      await this.prisma.contact.update({ where: { id: chat.contactId }, data: { firstMessageTagId: input.firstMessageTagId } });
    }
    const after = await this.profile(chat.contactId);

    // Journey entries on every chat of this contact.
    const record = (type: Parameters<JourneyService['recordForContact']>[1]['type'], data: Record<string, unknown>) =>
      this.journey.recordForContact(chat.contactId!, { type, actorType: 'MEMBER', actorUserId: user.id, data });
    for (const tag of added) await record('TAG_ADDED', { tag });
    for (const tag of removed) await record('TAG_REMOVED', { tag });
    for (const key of Object.keys(input.attributes ?? {})) {
      const from = before.attributes[key] ?? null;
      const to = after.attributes[key] ?? null;
      if (JSON.stringify(from) !== JSON.stringify(to)) await record('ATTRIBUTE_CHANGED', { key, from, to });
    }
    if (input.firstMessageTagId !== undefined && before.firstMessageTag?.id !== after.firstMessageTag?.id) {
      await record('FIRST_MESSAGE_TAG_CHANGED', { from: before.firstMessageTag?.name ?? null, to: after.firstMessageTag?.name ?? null });
    }
    await this.publisher.contactUpdated(chat.contactId);
    return after;
  }

  async setBlocked(user: RequestUser, contactId: string, blocked: boolean, ip: string | null = null): Promise<void> {
    const contact = await this.prisma.contact.findUnique({ where: { id: contactId }, select: { blockedAt: true } });
    if (!contact) throw AppError.notFound('Contact not found');
    if ((contact.blockedAt !== null) === blocked) return;
    const chats = await this.prisma.conversation.findMany({ where: { contactId }, select: { id: true, state: true, intervenedById: true } });
    await this.prisma.contact.update({ where: { id: contactId }, data: blocked ? { blockedAt: new Date(), blockedById: user.id } : { blockedAt: null, blockedById: null } });
    await this.journey.recordForContact(contactId, { type: blocked ? 'BLOCKED' : 'UNBLOCKED', actorType: 'MEMBER', actorUserId: user.id });
    await this.audit.record({ userId: user.id, ip }, blocked ? 'contact.blocked' : 'contact.unblocked', { type: 'contact', id: contactId });
    await this.publisher.contactUpdated(contactId);
    // Live lists drop or restore the chats (realtime-events.md rule 1).
    for (const chat of chats) await this.publisher.conversation(chat.id, { state: chat.state, intervenedById: chat.intervenedById, blocked: !blocked });
  }
}

/** Contact routes of live chat: profile edits, journey and blocking. */
@Controller()
export class ChatContactController {
  constructor(
    private readonly chatContacts: ChatContactService,
    private readonly conversations: ConversationsService,
    private readonly journey: JourneyService,
  ) {}

  @Get('inbox/conversations/:id/journey')
  @Require('inbox.view')
  async journeyOf(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string) {
    await this.conversations.loadVisible(viewer(user), id);
    return this.journey.entries(id);
  }

  @Patch('inbox/conversations/:id/contact')
  @Require('contacts.manage')
  edit(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(EditContactSchema)) body: EditContactInput) {
    return this.chatContacts.edit(user, id, body);
  }

  @Post('contacts/:id/block')
  @HttpCode(204)
  @Require('inbox.reply')
  async block(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null): Promise<void> {
    await this.chatContacts.setBlocked(user, id, true, ip);
  }

  @Delete('contacts/:id/block')
  @HttpCode(204)
  @Require('inbox.reply')
  async unblock(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @ClientIp() ip: string | null): Promise<void> {
    await this.chatContacts.setBlocked(user, id, false, ip);
  }
}
