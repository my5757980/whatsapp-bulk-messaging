import { Injectable, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { OutboundEvents, SWEEP_JOB } from './outbound-events.js';

// Every 30 seconds: re-adds the job of any due delivery that has none (a crash between a change's
// commit and its enqueue, a Redis restart). Job ids are per attempt, so a job that still exists is
// not added twice (feature 006, research R2).
const EVERY_MS = 30_000;
/** Only deliveries overdue by this long are swept, so a job about to run is left alone. */
const OVERDUE_MS = 30_000;
const BATCH = 1_000;

@Injectable()
export class WebhookSweepProcessor implements OnModuleInit, OnApplicationBootstrap {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly events: OutboundEvents,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.WEBHOOKS_OUT, SWEEP_JOB, () => this.sweep());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.WEBHOOKS_OUT)
      .upsertJobScheduler('webhooks-sweep', { every: EVERY_MS }, { name: SWEEP_JOB, opts: { removeOnComplete: true, removeOnFail: 50 } });
  }

  async sweep(): Promise<number> {
    const due = await this.prisma.webhookDelivery.findMany({
      where: { status: 'PENDING', nextAttemptAt: { lte: new Date(Date.now() - OVERDUE_MS) }, endpoint: { status: 'ACTIVE' } },
      select: { id: true, attempts: true },
      orderBy: { nextAttemptAt: 'asc' },
      take: BATCH,
    });
    for (const d of due) this.events.enqueue(d.id, d.attempts, 0, 's');
    return due.length;
  }
}
