import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { ProcessorRegistry } from '../../../common/queue/processor.registry.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { LiveChatSettingsService } from '../settings/live-chat-settings.service.js';
import { ChatRoutingService } from './chat-routing.service.js';

const JOB = 'inbox-autoresolve';
const EVERY_MS = 5 * 60_000;
const QUIET_MS = 24 * 3_600_000;

/** Auto-resolve (T051, FR-024, research R5): every 5 minutes, when switched on. */
@Injectable()
export class AutoResolveProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(AutoResolveProcessor.name);

  constructor(
    private readonly registry: ProcessorRegistry,
    private readonly queues: QueueRegistry,
    private readonly settings: LiveChatSettingsService,
    private readonly routing: ChatRoutingService,
  ) {}

  onModuleInit(): void {
    this.registry.registerHandler(QUEUES.MAINTENANCE, JOB, () => this.run());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.MAINTENANCE)
      .upsertJobScheduler(JOB, { every: EVERY_MS }, { name: JOB, opts: { removeOnComplete: true, removeOnFail: 20 } })
      .catch((error: unknown) => this.logger.warn({ err: (error as Error).message }, 'Could not schedule auto-resolve'));
  }

  /** Returns how many chats were resolved. */
  async run(): Promise<number> {
    if (!(await this.settings.get()).autoResolve) return 0;
    return this.routing.releaseChats({ quietSince: new Date(Date.now() - QUIET_MS) });
  }
}
