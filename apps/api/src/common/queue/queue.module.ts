import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Queue, type JobsOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { sendQueueName } from './queue.constants.js';
import { redisOptionsFromUrl, type RedisConnectionOptions } from './redis-connection.js';

export const REDIS_CLIENT = Symbol('REDIS_CLIENT');
export const REDIS_OPTIONS = Symbol('REDIS_OPTIONS');

/** Failed jobs are kept (removeOnFail: false) so nothing is silently dropped (Principle IV). */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  removeOnComplete: { age: 24 * 3600, count: 10_000 },
  removeOnFail: false,
};

/** Lazily creates BullMQ queues, including one send queue per WhatsApp number (T039). */
@Injectable()
export class QueueRegistry implements OnModuleDestroy {
  private readonly queues = new Map<string, Queue>();

  constructor(@Inject(REDIS_OPTIONS) private readonly connection: RedisConnectionOptions) {}

  get(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      queue = new Queue(name, { connection: this.connection, defaultJobOptions: DEFAULT_JOB_OPTIONS });
      this.queues.set(name, queue);
    }
    return queue;
  }

  sendQueue(numberId: string): Queue {
    return this.get(sendQueueName(numberId));
  }

  names(): string[] {
    return [...this.queues.keys()];
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all([...this.queues.values()].map((q) => q.close()));
  }
}

@Global()
@Module({
  providers: [
    {
      provide: REDIS_OPTIONS,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => redisOptionsFromUrl(config.REDIS_URL),
    },
    {
      provide: REDIS_CLIENT,
      inject: [APP_CONFIG],
      useFactory: (config: AppConfig) => new Redis(config.REDIS_URL, { maxRetriesPerRequest: 3 }),
    },
    QueueRegistry,
  ],
  exports: [REDIS_CLIENT, REDIS_OPTIONS, QueueRegistry],
})
export class QueueModule implements OnModuleDestroy {
  constructor(@Inject(REDIS_CLIENT) private readonly redis: Redis) {}

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit();
  }
}
