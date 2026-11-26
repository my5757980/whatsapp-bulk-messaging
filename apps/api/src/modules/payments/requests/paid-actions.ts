import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { PaymentRequest } from '../../../generated/prisma/client.js';
import { FlowSessionService } from '../../flows/engine/session.service.js';
import { DripEvents } from '../../growth/drips/drip-events.js';
import { PlatformEvents } from '../../integrations/webhooks/platform-events.js';
import { PaymentEffects, type PaymentChange } from './payment-effects.js';

// When a request is paid (feature 008, FR-013): its tag is added (as chat links add theirs: drips,
// webhook endpoints, the journey) and its flow starts, by the 006 chat-link rule: never over a running
// flow (the start is refused) and never in a chat a member has taken.

@Injectable()
export class PaidActions implements OnModuleInit {
  private readonly logger = new Logger(PaidActions.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly effects: PaymentEffects,
    private readonly dripEvents: DripEvents,
    private readonly platformEvents: PlatformEvents,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.effects.registerHook((request, changes) => this.onChange(request, changes));
  }

  private async onChange(request: PaymentRequest, changes: PaymentChange[]): Promise<void> {
    if (!changes.includes('PAID') || !request.contactId) return;
    if (request.tagId) await this.addTag(request.contactId, request.tagId, request.description);
    if (!request.flowId) return;
    const conversationId = request.conversationId ?? (await this.chatOf(request.contactId, request.messageId));
    if (conversationId) await this.startFlow(request.flowId, conversationId);
  }

  /** The contact's chat on the number that sent the request's message (campaign requests). */
  private async chatOf(contactId: string, messageId: string | null): Promise<string | null> {
    const message = messageId ? await this.prisma.message.findUnique({ where: { id: messageId }, select: { numberId: true } }) : null;
    const chat = await this.prisma.conversation.findFirst({ where: { contactId, ...(message ? { numberId: message.numberId } : {}) }, orderBy: { lastActivityAt: 'desc' }, select: { id: true } });
    return chat?.id ?? null;
  }

  private async addTag(contactId: string, tagId: string, description: string): Promise<void> {
    const tag = await this.prisma.tag.findUnique({ where: { id: tagId }, select: { name: true } });
    if (!tag) return;
    await this.prisma.$transaction(async (tx) => {
      const added = await tx.contactTag.createManyAndReturn({ data: [{ contactId, tagId }], skipDuplicates: true, select: { contactId: true, tagId: true } });
      if (!added.length) return;
      await this.dripEvents.recordTagAddedToMany(tx, added);
      await this.platformEvents.tagLinksChanged(tx, added);
      const chats = await tx.conversation.findMany({ where: { contactId }, select: { id: true } });
      await tx.conversationEvent.createMany({ data: chats.map((c) => ({ conversationId: c.id, type: 'TAG_ADDED' as const, actorType: 'SYSTEM' as const, data: { tag: tag.name, payment: description } })) });
    });
  }

  private async startFlow(flowId: string, conversationId: string): Promise<void> {
    const chat = await this.prisma.conversation.findUnique({ where: { id: conversationId }, select: { state: true } });
    if (!chat || chat.state !== 'ACTIVE') return;
    const flow = await this.prisma.flow.findUnique({ where: { id: flowId }, select: { id: true, status: true, deletedAt: true, publishedVersionId: true } });
    if (!flow || flow.deletedAt || flow.status !== 'PUBLISHED' || !flow.publishedVersionId) return;
    const sessions = this.moduleRef.get(FlowSessionService, { strict: false });
    const outcome = await sessions.start({ flowId: flow.id, versionId: flow.publishedVersionId, conversationId, startedBy: 'TRIGGER', triggerKey: 'payment' });
    if (!outcome.started) this.logger.log({ conversationId, flowId }, 'The paid request’s flow did not start (another flow is running)');
  }
}
