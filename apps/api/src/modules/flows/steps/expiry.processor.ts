import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { FlowSessionService } from '../engine/session.service.js';
import { FLOW_EXPIRY_JOB } from './flow-jobs.js';
import { FlowsQueueProcessor } from './flows-queue.processor.js';

const EVERY_MS = 5 * 60_000;
/** FR-032: a session with no activity for 24 hours ends as EXPIRED. */
export const FLOW_IDLE_MS = 24 * 3_600_000;
const BATCH = 500;

/** The expiry sweep (003 T034): every 5 minutes, ends sessions idle for 24 hours. */
@Injectable()
export class FlowExpiryProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(FlowExpiryProcessor.name);

  constructor(
    private readonly flowsQueue: FlowsQueueProcessor,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly sessions: FlowSessionService,
  ) {}

  onModuleInit(): void {
    this.flowsQueue.handle(FLOW_EXPIRY_JOB, () => this.run());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.FLOWS)
      .upsertJobScheduler(FLOW_EXPIRY_JOB, { every: EVERY_MS }, { name: FLOW_EXPIRY_JOB, opts: { removeOnComplete: true, removeOnFail: 20 } })
      .catch((error: unknown) => this.logger.warn({ err: (error as Error).message }, 'Could not schedule the flow expiry sweep'));
  }

  /** Returns how many sessions ended; `now` is a parameter for tests. */
  async run(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - FLOW_IDLE_MS);
    let ended = 0;
    for (;;) {
      const idle = await this.prisma.flowSession.findMany({
        where: { status: 'RUNNING', lastActivityAt: { lt: cutoff } },
        select: { id: true },
        orderBy: { lastActivityAt: 'asc' },
        take: BATCH,
      });
      for (const session of idle) if (await this.sessions.expire(session.id, cutoff)) ended++;
      if (idle.length < BATCH) break;
    }
    if (ended) this.logger.log({ ended }, 'Idle flow sessions expired');
    return ended;
  }
}
