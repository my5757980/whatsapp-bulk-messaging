import { HttpStatus, Injectable } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { assistantRequestJob } from '../ai-jobs.js';
import { AiUsageService } from '../usage/usage.service.js';
import { toRequestDto } from './assistant-views.js';

export const AssistantRequestSchema = z.strictObject({ prompt: z.string().trim().min(1).max(2000) });
export type AssistantRequestInput = z.infer<typeof AssistantRequestSchema>;

/** A member sees the latest 50 of their own requests. */
const HISTORY = 50;

/**
 * Team assistant requests (004 T100, research R14): stored and queued, then answered in the worker.
 * The monthly assistant limit (FR-046) is checked here; a request is counted when it is answered.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly usage: AiUsageService,
  ) {}

  async create(userId: string, input: AssistantRequestInput) {
    const settings = await this.usage.settings();
    if (await this.usage.assistantLimitReached(settings)) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'LIMIT_REACHED', 'The monthly assistant limit is reached. An admin can raise it on the AI usage page.');
    }
    const row = await this.prisma.assistantRequest.create({ data: { userId, prompt: input.prompt }, include: { actions: true } });
    const job = assistantRequestJob(row.id);
    try {
      await this.queues.get(QUEUES.AI).add(job.name, job.data, job.opts);
    } catch (error) {
      await this.prisma.assistantRequest.update({ where: { id: row.id }, data: { status: 'FAILED', errorCode: 'AI_UNAVAILABLE', finishedAt: new Date() } });
      throw error;
    }
    return toRequestDto(row);
  }

  async list(userId: string) {
    const rows = await this.prisma.assistantRequest.findMany({ where: { userId }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: HISTORY, include: { actions: true } });
    const now = new Date();
    return rows.map((row) => toRequestDto(row, now));
  }

  async get(id: string, userId: string) {
    const row = await this.prisma.assistantRequest.findFirst({ where: { id, userId }, include: { actions: true } });
    if (!row) throw AppError.notFound('Request not found');
    return toRequestDto(row);
  }
}
