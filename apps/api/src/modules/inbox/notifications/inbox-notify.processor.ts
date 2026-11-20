import { Injectable } from '@nestjs/common';
import { maskPhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Role } from '../../../generated/prisma/client.js';
import { SUMMARY_INCLUDE } from '../conversations/conversation-views.js';
import { previewOf } from '../inbound/message-parser.js';
import type { InboxNotifyJobData } from '../inbox-queue.js';
import { ChatRoutingService } from '../routing/chat-routing.service.js';
import { PushService } from './push.service.js';

/** Push texts stay short on lock screens (research R9). */
export const PUSH_PREVIEW_MAX = 80;

function cut(text: string, max = PUSH_PREVIEW_MAX): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Turns an `inbox` queue `notify` job into push alerts (T087, FR-037): a new customer message for
 * every member who may see the chat, a chat waiting for an agent, a transfer, or a mention.
 * Agents see a masked phone number when the contact has no name (FR-029).
 */
@Injectable()
export class InboxNotifyProcessor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly routing: ChatRoutingService,
    private readonly push: PushService,
  ) {}

  async process(data: InboxNotifyJobData): Promise<number> {
    if (!this.push.enabled) return 0;
    const chat = await this.prisma.conversation.findUnique({ where: { id: data.conversationId }, include: SUMMARY_INCLUDE });
    // Blocked contacts raise no alerts (FR-034).
    if (!chat || chat.contact?.blockedAt) return 0;
    const phone = chat.contact?.phoneE164 ?? null;
    const who = (role: Role) => chat.contact?.name ?? (role === 'AGENT' ? maskPhone(phone) : phone) ?? 'A customer';
    const url = `/inbox?c=${chat.id}`;
    const tag = `chat-${chat.id}`;

    if (data.kind === 'message') {
      const item = await this.prisma.chatMessage.findUnique({ where: { id: data.itemId }, select: { contentType: true, text: true, payload: true } });
      if (!item) return 0;
      const body = cut(previewOf({ contentType: item.contentType, text: item.text, payload: (item.payload ?? {}) as Record<string, unknown> }));
      return this.push.send(await this.routing.membersWhoMaySee(chat), (r) => ({ title: cut(who(r.role)), body, url, tag }));
    }

    const recipients = await this.prisma.user.findMany({ where: { id: { in: data.userIds }, status: 'ACTIVE' }, select: { id: true, role: true } });
    switch (data.kind) {
      case 'requesting':
        return this.push.send(recipients, (r) => ({ title: 'Waiting for an agent', body: cut(`${who(r.role)} asked to talk to a person`), url, tag }));
      case 'transferred':
        return this.push.send(recipients, (r) => ({ title: 'Chat transferred to you', body: cut(`${data.byName} transferred the chat with ${who(r.role)} to you`), url, tag }));
      case 'mention':
        return this.push.send(recipients, (r) => ({ title: cut(`${data.byName} mentioned you`), body: cut(`In the chat with ${who(r.role)}`), url, tag }));
    }
  }
}
