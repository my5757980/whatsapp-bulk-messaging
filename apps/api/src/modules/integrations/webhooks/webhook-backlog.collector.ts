import { Injectable, type OnModuleInit } from '@nestjs/common';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';

/**
 * Fills `wbm_webhook_backlog` at scrape time (feature 006, research R14): deliveries to active endpoints
 * that have been due for more than 5 minutes. The api and the worker both run it, like the queue depth,
 * so the WbmWebhookBacklog alert reads the highest value.
 */
@Injectable()
export class WebhookBacklogCollector implements OnModuleInit {
  constructor(
    private readonly metrics: MetricsService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.metrics.onScrape(() => this.collect());
  }

  async collect(): Promise<void> {
    const [row] = await this.prisma.$queryRaw<Array<{ n: number }>>`
      SELECT count(*)::int AS n
        FROM webhook_deliveries d
        JOIN webhook_endpoints e ON e.id = d.endpoint_id
       WHERE d.status = 'PENDING' AND e.status = 'ACTIVE' AND d.next_attempt_at < now() - interval '5 minutes'`;
    this.metrics.webhookBacklog.set(row?.n ?? 0);
  }
}
