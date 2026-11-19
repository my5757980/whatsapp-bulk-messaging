import { Inject, Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry, REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import { InboxPublisher } from '../realtime/inbox-publisher.js';

const JOB = 'inbox-window';
const EVERY_MS = 60_000;
/** Never look further back than this, e.g. after the worker was down for a while. */
const MAX_LOOKBACK_MS = 10 * 60_000;
export const WINDOW_CLOSE_LAST_RUN_KEY = 'wbm:inbox:window-close:last';
const LAST_RUN_KEY = WINDOW_CLOSE_LAST_RUN_KEY;

/**
 * Publishes `conversation.window_closed` for chats whose 24-hour window ended since the last run
 * (T043, research R5), so open screens move them to Past chats within a minute (SC-005).
 */
@Injectable()
export class WindowCloseProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(WindowCloseProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly publisher: InboxPublisher,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, JOB, () => this.run());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler(JOB, { every: EVERY_MS }, { name: JOB, opts: { removeOnComplete: true, removeOnFail: 20 } })
      .catch((error: unknown) => this.logger.warn({ err: (error as Error).message }, 'Could not schedule the window-close job'));
  }

  /** Returns how many chats were announced. */
  async run(): Promise<number> {
    const now = Date.now();
    const last = Number(await this.redis.get(LAST_RUN_KEY).catch(() => null));
    const from = new Date(Math.max(Number.isFinite(last) && last > 0 ? last : now - EVERY_MS - 10_000, now - MAX_LOOKBACK_MS));
    const to = new Date(now);
    const closed = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c.id FROM conversations c
       WHERE c.last_customer_message_at + interval '24 hours' > ${from}
         AND c.last_customer_message_at + interval '24 hours' <= ${to}`;
    for (const { id } of closed) await this.publisher.windowClosed(id);
    await this.redis.set(LAST_RUN_KEY, String(now)).catch(() => undefined);
    return closed.length;
  }
}
