import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { DELIVER_JOB, OutboundEvents, type DeliverJobData } from './outbound-events.js';
import { WebhookDeliveries, type DeliveryOutcome } from './webhook-deliveries.service.js';

// The webhook delivery worker (feature 006, research R2): each `deliver` job on the `webhooks-out`
// queue is one attempt, with up to 20 at once across endpoints (five per endpoint, enforced by
// WebhookDeliveries).

/** A job that finds no row waits this long and looks again, a few times (the change may not have committed). */
const ROW_WAIT_MS = 2_000;
const ROW_WAIT_TRIES = 3;

@Injectable()
export class WebhookDeliveryProcessor implements OnModuleInit {
  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly prisma: PrismaService,
    private readonly events: OutboundEvents,
    private readonly deliveries: WebhookDeliveries,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.WEBHOOKS_OUT, DELIVER_JOB, (job: Job<DeliverJobData>) => this.run(job), { concurrency: 20 });
  }

  /** The endpoint answer limit; tests make it shorter. */
  get timeoutMs(): number {
    return this.deliveries.timeoutMs;
  }

  set timeoutMs(value: number) {
    this.deliveries.timeoutMs = value;
  }

  deliver(deliveryId: string, options: { attempt?: number } = {}): Promise<DeliveryOutcome> {
    return this.deliveries.deliver(deliveryId, options);
  }

  inFlight(endpointId: string): Promise<number> {
    return this.deliveries.inFlight(endpointId);
  }

  private async run(job: Job<DeliverJobData>): Promise<DeliveryOutcome> {
    const { deliveryId, attempt, waitingForRow = 0 } = job.data;
    if (!(await this.prisma.webhookDelivery.count({ where: { id: deliveryId } }))) {
      if (waitingForRow < ROW_WAIT_TRIES) this.events.enqueue(deliveryId, attempt, ROW_WAIT_MS, `w${waitingForRow + 1}`, waitingForRow + 1);
      return 'skipped';
    }
    return this.deliveries.deliver(deliveryId, { attempt });
  }
}
