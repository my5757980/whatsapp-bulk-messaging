import { randomUUID } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../src/common/queue/processor.registry.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { redisOptionsFromUrl } from '../../src/common/queue/redis-connection.js';
import { campaignSendJob, sessionSendJob } from '../../src/modules/sending/send-jobs.js';
import { SendQueueManager } from '../../src/modules/sending/send-queue.manager.js';
import type { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { waitUntil } from '../support/sse-client.js';

// T012: a live chat reply jumps ahead of a running broadcast on the same number, while the
// number's rate limit still holds (research R3, Principle IV). Real BullMQ workers and Redis.
const RATE_PER_SECOND = 50;
const CAMPAIGN_JOBS = 200;

const connection = redisOptionsFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379');
const queues = new QueueRegistry(connection);
const registry = new ProcessorRegistry(connection);
const processed: Array<{ key: string; at: number }> = [];
const fakeSender = {
  process: async (messageId: string) => {
    processed.push({ key: messageId, at: Date.now() });
    return { result: 'sent' as const };
  },
} as unknown as SendProcessor;
const manager = new SendQueueManager(registry, queues, {} as PrismaService, fakeSender);
const numberId = randomUUID();
let processedWhenReplyQueued = 0;

beforeAll(async () => {
  manager.registerJobHandler('session', async (job: Job<{ chatMessageId: string }>) => {
    processed.push({ key: `session:${job.data.chatMessageId}`, at: Date.now() });
    return { result: 'sent' };
  });
  registry.onApplicationBootstrap();

  const queue = queues.sendQueue(numberId);
  await queue.addBulk(Array.from({ length: CAMPAIGN_JOBS }, (_, i) => campaignSendJob(`campaign-${String(i).padStart(3, '0')}`)));
  await manager.ensureWorker(numberId, RATE_PER_SECOND);

  await waitUntil(() => processed.length >= 20, 10_000);
  processedWhenReplyQueued = processed.length;
  const reply = sessionSendJob('reply-1');
  await queue.add(reply.name, reply.data, reply.opts);
  await waitUntil(() => processed.length >= CAMPAIGN_JOBS + 1, 20_000);
}, 40_000);

afterAll(async () => {
  await registry.onModuleDestroy();
  await queues.sendQueue(numberId).obliterate({ force: true });
  await queues.onModuleDestroy();
});

describe('send priority on a number queue', () => {
  it('processes the reply before the rest of the campaign', () => {
    const replyIndex = processed.findIndex((p) => p.key === 'session:reply-1');
    expect(replyIndex).toBeGreaterThanOrEqual(processedWhenReplyQueued);
    // Within one rate-limit window of being queued, far ahead of the remaining campaign jobs.
    expect(replyIndex - processedWhenReplyQueued).toBeLessThan(RATE_PER_SECOND);
    expect(processed.slice(replyIndex + 1).length).toBeGreaterThan(50);
  });

  it('sends every campaign message exactly once', () => {
    const campaign = processed.filter((p) => p.key.startsWith('campaign-')).map((p) => p.key);
    expect(new Set(campaign).size).toBe(CAMPAIGN_JOBS);
    expect(campaign).toHaveLength(CAMPAIGN_JOBS);
  });

  it('still respects the per-number rate limit', () => {
    // 201 jobs at 50 per second need at least four rate windows.
    const elapsed = processed.at(-1)!.at - processed[0]!.at;
    expect(elapsed).toBeGreaterThanOrEqual(Math.floor((CAMPAIGN_JOBS + 1) / RATE_PER_SECOND - 1) * 1000);
  });
});
