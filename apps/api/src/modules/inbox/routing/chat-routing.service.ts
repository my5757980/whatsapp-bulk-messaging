import { Injectable } from '@nestjs/common';
import { can } from '@wbm/shared';
import type { Role } from '../../../generated/prisma/client.js';
import { maskPhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { AgentRulesLoader } from '../conversations/agent-rules.loader.js';
import { factsOf, SUMMARY_INCLUDE, type ConversationRow } from '../conversations/conversation-views.js';
import { canAccess, seesAll } from '../conversations/visibility.js';
import { InboxNotifier } from '../notifications/inbox-notifier.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';

/**
 * Routing work shared by the HTTP app and the worker (US3): alerts for chats waiting for an
 * agent or transferred (in-app, and push from US7), and returning taken chats to Open
 * (auto-resolve, deactivation).
 */
@Injectable()
export class ChatRoutingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rules: AgentRulesLoader,
    private readonly notifications: NotificationsService,
    private readonly publisher: InboxPublisher,
    private readonly notifier: InboxNotifier,
  ) {}

  /** Active members with live chat access who may see the chat (FR-019). */
  async membersWhoMaySee(chat: ConversationRow): Promise<Array<{ id: string; role: Role }>> {
    const facts = factsOf(chat);
    const members = await this.prisma.user.findMany({ where: { status: 'ACTIVE' }, select: { id: true, role: true } });
    const visible: Array<{ id: string; role: Role }> = [];
    for (const member of members) {
      if (!can(member.role, 'inbox.view')) continue;
      const rules = seesAll(member) ? [] : await this.rules.forUser(member.id);
      if (canAccess(member, rules, facts)) visible.push(member);
    }
    return visible;
  }

  /** In-app alert to every active member who may see the chat (FR-021). */
  async alertRequesting(conversationId: string): Promise<number> {
    const chat = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: SUMMARY_INCLUDE });
    if (!chat || chat.contact?.blockedAt) return 0;
    const recipients = (await this.membersWhoMaySee(chat)).map((m) => m.id);
    await this.notifier.queue({ kind: 'requesting', conversationId, userIds: recipients });
    // Notifications never carry a full phone number (FR-029).
    const who = chat.contact?.name ?? maskPhone(chat.contact?.phoneE164) ?? 'A customer';
    return this.notifications.notifyUsers(recipients, {
      type: 'INBOX_REQUESTING',
      title: 'Waiting for an agent',
      body: `${who} asked to talk to a person`,
      link: `/inbox?c=${conversationId}`,
    });
  }

  async alertTransferred(conversationId: string, toUserId: string, byName: string): Promise<void> {
    const chat = await this.prisma.conversation.findUnique({ where: { id: conversationId }, include: SUMMARY_INCLUDE });
    const who = chat?.contact?.name ?? maskPhone(chat?.contact?.phoneE164) ?? 'a customer';
    await this.notifier.queue({ kind: 'transferred', conversationId, userIds: [toUserId], byName });
    await this.notifications.notifyUsers([toUserId], {
      type: 'INBOX_TRANSFERRED',
      title: 'Chat transferred to you',
      body: `${byName} transferred the chat with ${who} to you`,
      link: `/inbox?c=${conversationId}`,
    });
  }

  /**
   * Returns taken chats to Open with a system journey entry: quiet ones when auto-resolve is on
   * (`ownerId` omitted, FR-024) or all of a deactivated member's chats (FR-025).
   */
  async releaseChats(filter: { quietSince: Date } | { ownerId: string }): Promise<number> {
    const now = new Date();
    const due = await this.prisma.conversation.findMany({
      where: { state: 'INTERVENED', ...('ownerId' in filter ? { intervenedById: filter.ownerId } : { lastActivityAt: { lt: filter.quietSince } }) },
      select: { id: true, intervenedById: true, contact: { select: { blockedAt: true } } },
      take: 500,
    });
    let released = 0;
    for (const chat of due) {
      const done = await this.prisma.$transaction(async (tx) => {
        const updated = await tx.conversation.updateMany({
          where: { id: chat.id, state: 'INTERVENED', intervenedById: chat.intervenedById },
          data: { state: 'ACTIVE', intervenedById: null, intervenedAt: null, unresolvedRequests: 0 },
        });
        if (!updated.count) return false;
        await tx.conversationEvent.create({
          data: {
            conversationId: chat.id,
            type: 'AUTO_RESOLVED',
            actorType: 'SYSTEM',
            occurredAt: now,
            data: { reason: 'ownerId' in filter ? 'owner_deactivated' : 'inactive_24h', previousOwnerId: chat.intervenedById },
          },
        });
        const opening = await tx.conversationOpening.findFirst({ where: { conversationId: chat.id }, orderBy: { openedAt: 'desc' }, select: { id: true } });
        if (opening) await tx.conversationOpening.updateMany({ where: { id: opening.id, resolvedAt: null }, data: { resolvedAt: now } });
        return true;
      });
      if (!done) continue;
      released += 1;
      await this.publisher.conversation(chat.id, { state: 'INTERVENED', intervenedById: chat.intervenedById, blocked: chat.contact?.blockedAt != null });
    }
    return released;
  }
}
