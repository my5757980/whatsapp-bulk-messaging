import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { AI_EXPIRY_JOB } from '../ai-jobs.js';
import { AiQueueProcessor } from './ai-queue.processor.js';
import { AiConversationsService } from './ai-conversations.service.js';

const SWEEP_EVERY_MS = 15 * 60_000;
const IDLE_MS = 24 * 3_600_000;
const BATCH = 500;

/**
 * The `ai-expiry` sweep (T055, data-model.md §3): every 15 minutes, ACTIVE AI conversations without
 * activity for 24 hours end as EXPIRED, so a customer who returns later starts a fresh one.
 */
@Injectable()
export class AiExpiryProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(AiExpiryProcessor.name);

  constructor(
    private readonly aiQueue: AiQueueProcessor,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly conversations: AiConversationsService,
  ) {}

  onModuleInit(): void {
    this.aiQueue.handle(AI_EXPIRY_JOB, () => this.sweep());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.AI)
      .upsertJobScheduler(AI_EXPIRY_JOB, { every: SWEEP_EVERY_MS }, { name: AI_EXPIRY_JOB, opts: { removeOnComplete: true, removeOnFail: 20 } })
      .catch((error: unknown) => this.logger.warn({ err: (error as Error).message }, 'Could not schedule the AI conversation expiry'));
  }

  /** Ends idle AI conversations; returns how many ended. */
  async sweep(now: Date = new Date()): Promise<number> {
    const idle = await this.prisma.aiConversation.findMany({
      where: { status: 'ACTIVE', lastActivityAt: { lt: new Date(now.getTime() - IDLE_MS) } },
      orderBy: { lastActivityAt: 'asc' },
      take: BATCH,
      select: { conversationId: true },
    });
    let ended = 0;
    for (const row of idle) if (await this.conversations.endForConversation(row.conversationId, 'EXPIRED')) ended += 1;
    if (ended) this.logger.log({ ended }, 'Idle AI conversations expired');
    return ended;
  }
}
