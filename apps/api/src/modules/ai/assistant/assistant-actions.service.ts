import { HttpStatus, Injectable } from '@nestjs/common';
import { can, type Role } from '@wbm/shared';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { AssistantAction, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { LaunchService } from '../../campaigns/launch.service.js';
import { ScheduleService } from '../../campaigns/schedule.service.js';
import { ContactDeletionService } from '../../contacts/contact-deletion.service.js';
import { ACTION_PERMISSION } from './assistant-tools.js';
import { toActionDto } from './assistant-views.js';

interface ActionParams {
  campaignId?: string;
  scheduledAt?: string | null;
  contactIds?: string[];
  tagIds?: string[];
}

/**
 * Confirming or cancelling what the assistant prepared (004 T102, FR-044, FR-045). Only the member
 * who asked may decide, within 30 minutes; their permission is checked again, and the action runs
 * through the existing services with the member as actor.
 */
@Injectable()
export class AssistantActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly launch: LaunchService,
    private readonly schedule: ScheduleService,
    private readonly deletion: ContactDeletionService,
    private readonly audit: AuditService,
  ) {}

  async confirm(id: string, member: { id: string; role: Role }, ip: string | null) {
    const action = await this.own(id, member.id);
    if (action.status !== 'PENDING') throw AppError.conflict('This action was already decided', 'ACTION_DECIDED');
    if (action.expiresAt.getTime() <= Date.now()) {
      await this.prisma.assistantAction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'EXPIRED', decidedAt: new Date() } });
      throw AppError.conflict('This preview has expired; ask the assistant again', 'ACTION_EXPIRED');
    }
    if (!can(member.role, ACTION_PERMISSION[action.kind])) throw new AppError(HttpStatus.FORBIDDEN, 'FORBIDDEN', 'Your role no longer allows this action');
    // Exactly one confirm runs the action, however many arrive at once.
    const claimed = await this.prisma.assistantAction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CONFIRMED', decidedAt: new Date() } });
    if (!claimed.count) throw AppError.conflict('This action was already decided', 'ACTION_DECIDED');

    const actor: AuditActor = { userId: member.id, ip };
    let status: 'CONFIRMED' | 'FAILED' = 'CONFIRMED';
    let result: Record<string, unknown>;
    try {
      result = await this.execute(action, actor);
    } catch (error) {
      status = 'FAILED';
      result = { code: error instanceof AppError ? error.code : 'FAILED', message: error instanceof Error ? error.message : 'The action failed' };
    }
    const updated = await this.prisma.assistantAction.update({ where: { id }, data: { status, result: result as Prisma.InputJsonValue } });
    await this.audit.record(actor, 'ai.assistant_action_confirmed', { type: 'assistant_action', id }, { kind: action.kind, requestId: action.requestId, outcome: status, ...result });
    return toActionDto(updated);
  }

  async cancel(id: string, memberId: string) {
    await this.own(id, memberId);
    const cancelled = await this.prisma.assistantAction.updateMany({ where: { id, status: 'PENDING' }, data: { status: 'CANCELLED', decidedAt: new Date() } });
    if (!cancelled.count) throw AppError.conflict('This action was already decided', 'ACTION_DECIDED');
    return toActionDto(await this.prisma.assistantAction.findUniqueOrThrow({ where: { id } }));
  }

  private async own(id: string, memberId: string): Promise<AssistantAction> {
    const action = await this.prisma.assistantAction.findFirst({ where: { id, userId: memberId } });
    if (!action) throw AppError.notFound('Action not found');
    return action;
  }

  private async execute(action: AssistantAction, actor: AuditActor): Promise<Record<string, unknown>> {
    const params = (action.params ?? {}) as ActionParams;
    switch (action.kind) {
      case 'SEND_CAMPAIGN':
        await this.launch.launch(params.campaignId!, {}, actor);
        return { campaignId: params.campaignId };
      case 'SCHEDULE_CAMPAIGN':
        await this.schedule.schedule(params.campaignId!, { scheduledAt: params.scheduledAt! }, actor);
        return { campaignId: params.campaignId, scheduledAt: params.scheduledAt };
      case 'DELETE_CONTACTS': {
        let deleted = 0;
        for (const contactId of params.contactIds ?? []) {
          try {
            await this.deletion.delete(contactId, actor);
            deleted += 1;
          } catch (error) {
            // Deleted meanwhile: nothing left to do for that one.
            if (!(error instanceof AppError && error.status === HttpStatus.NOT_FOUND)) throw error;
          }
        }
        return { deleted };
      }
      case 'DELETE_TAGS': {
        const { count } = await this.prisma.tag.deleteMany({ where: { id: { in: params.tagIds ?? [] } } });
        return { deleted: count };
      }
    }
  }
}
