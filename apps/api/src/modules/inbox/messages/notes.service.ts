import { Body, Controller, Injectable, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { ITEM_INCLUDE, toItemDto } from '../conversations/conversation-views.js';
import { ConversationsService } from '../conversations/conversations.service.js';
import { InboxNotifier } from '../notifications/inbox-notifier.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';
import { ChatRoutingService } from '../routing/chat-routing.service.js';

/** POST /inbox/conversations/{id}/notes (contracts/inbox-api.openapi.yaml). */
export const NoteInputSchema = z.strictObject({
  text: z.string().trim().min(1).max(4096),
  mentions: z.array(z.uuid()).max(10).optional(),
});
export type NoteInput = z.infer<typeof NoteInputSchema>;

/**
 * Internal notes (T092, FR-038): only the team sees them and they are never sent. Mentioned
 * teammates must be able to see the chat; they get an in-app alert and a push alert.
 */
@Injectable()
export class NotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly conversations: ConversationsService,
    private readonly routing: ChatRoutingService,
    private readonly notifications: NotificationsService,
    private readonly notifier: InboxNotifier,
    private readonly publisher: InboxPublisher,
  ) {}

  async create(viewer: RequestUser, conversationId: string, input: NoteInput) {
    const chat = await this.conversations.loadVisible(viewer, conversationId);
    const mentions = [...new Set(input.mentions ?? [])];
    if (mentions.length) {
      const allowed = new Set((await this.routing.membersWhoMaySee(chat)).map((m) => m.id));
      const details = mentions.flatMap((id, i) => (allowed.has(id) ? [] : [{ field: `mentions[${i}]`, issue: 'is not an active member who can see this chat' }]));
      if (details.length) throw AppError.validation('Some mentioned members cannot see this chat', details);
    }
    // A note never touches the list order or preview, and nothing is queued for WhatsApp.
    const note = await this.prisma.chatMessage.create({
      data: { conversationId, kind: 'NOTE', origin: 'MEMBER', contentType: 'TEXT', text: input.text, payload: { mentions }, sentByUserId: viewer.id, occurredAt: new Date() },
      include: ITEM_INCLUDE,
    });
    await this.publisher.itemCreated(note.id, mentions);

    const alerted = mentions.filter((id) => id !== viewer.id);
    if (alerted.length) {
      // In-app alerts never carry a full phone number (FR-029).
      const who = chat.contact?.name ?? maskPhone(chat.contact?.phoneE164) ?? 'a customer';
      await this.notifications.notifyUsers(alerted, {
        type: 'INBOX_MENTION',
        title: 'You were mentioned',
        body: `${viewer.name} mentioned you in the chat with ${who}`,
        link: `/inbox?c=${conversationId}`,
      });
      await this.notifier.queue({ kind: 'mention', conversationId, userIds: alerted, byName: viewer.name });
    }
    return toItemDto(note);
  }
}

@Controller('inbox/conversations')
export class NotesController {
  constructor(private readonly notes: NotesService) {}

  @Post(':id/notes')
  @Require('inbox.reply')
  create(@CurrentUser() user: RequestUser, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(NoteInputSchema)) body: NoteInput) {
    return this.notes.create(user, id, body);
  }
}
