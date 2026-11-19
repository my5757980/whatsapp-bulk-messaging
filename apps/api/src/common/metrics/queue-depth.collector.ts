import { Injectable, type OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { QUEUES, sendQueueName } from '../queue/queue.constants.js';
import { QueueRegistry } from '../queue/queue.module.js';
import { MetricsService } from './metrics.service.js';

/**
 * Fills `wbm_queue_depth` at scrape time (research R19, T194). Both the api and the worker run it,
 * so a stopped worker still shows up as a growing queue on the api's /metrics.
 */
@Injectable()
export class QueueDepthCollector implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.metrics.onScrape(() => this.collect());
  }

  async collect(): Promise<void> {
    const numbers = await this.prisma.whatsAppNumber.findMany({ where: { connectionStatus: { not: 'DISCONNECTED' } }, select: { id: true } });
    const names = [...Object.values(QUEUES), ...numbers.map((n) => sendQueueName(n.id))];
    const depths = await Promise.all(
      names.map(async (queue) => {
        const counts = await this.queues.get(queue).getJobCounts('waiting', 'prioritized');
        return { queue, depth: Object.values(counts).reduce((sum, n) => sum + n, 0) };
      }),
    );
    this.metrics.queueDepth.reset();
    for (const { queue, depth } of depths) this.metrics.queueDepth.set({ queue }, depth);
  }
}
