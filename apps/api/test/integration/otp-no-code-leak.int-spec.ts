import { inspect } from 'node:util';
import { Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { ProcessorRegistry } from '../../src/common/queue/processor.registry.js';
import { QueueRegistry, REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { redisOptionsFromUrl } from '../../src/common/queue/redis-connection.js';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { sendJobId } from '../../src/modules/sending/dispatch-planner.js';
import { SendQueueManager } from '../../src/modules/sending/send-queue.manager.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { digits, restoreNetwork, seedNumber, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { apiKeyWithScopes, seedAuthTemplate, sendCode } from '../support/templates.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T092 (feature 009, SC-002, research R4): a one-time code is only ever in the request, the encrypted send job
// and Meta's payload. After a success, a failure, a retry (a 5xx, then success) and an idempotent repeat, no
// code appears in messages, events, idempotency records, audit entries, outbound events, logs or the send
// queue's Redis data, and a real worker leaves no job behind.
describe('One-time codes never leak (009 SC-002)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let fake: FakeTemplatesGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let key: string;
  let endpointId: string;
  const logs: string[] = [];
  const codes = { ok: `Zq${digits(6)}`, failed: `Zw${digits(6)}`, retried: `Zr${digits(6)}`, repeated: `Zp${digits(6)}` };

  const queue = () => ctx.app.get(QueueRegistry).sendQueue(number.id);
  /** Runs the code's send job as the worker would, after checking BullMQ deletes it once done. */
  const run = async (messageId: string, attempt = 1) => {
    const job = await queue().getJob(sendJobId(messageId));
    expect(job?.opts).toMatchObject({ removeOnComplete: true, removeOnFail: true });
    return ctx.app.get(SendProcessor).process(messageId, attempt, (job?.data as { codeEnc?: string } | undefined)?.codeEnc);
  };
  /** Every Redis value of the number's send queue, as text. */
  const redisData = async (): Promise<Array<[string, string]>> => {
    const redis = ctx.app.get<Redis>(REDIS_CLIENT);
    const found: Array<[string, string]> = [];
    for (const k of await redis.keys(`*send-${number.id}*`)) {
      const type = await redis.type(k);
      const value =
        type === 'hash'
          ? JSON.stringify(await redis.hgetall(k))
          : type === 'string'
            ? ((await redis.get(k)) ?? '')
            : type === 'list'
              ? JSON.stringify(await redis.lrange(k, 0, -1))
              : type === 'zset'
                ? JSON.stringify(await redis.zrange(k, '0', '-1'))
                : type === 'set'
                  ? JSON.stringify(await redis.smembers(k))
                  : type === 'stream'
                    ? JSON.stringify(await redis.xrange(k, '-', '+'))
                    : '';
      found.push([`redis ${k}`, value]);
    }
    return found;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    number = await seedNumber(ctx);
    fake = new FakeTemplatesGraph().install();
    const template = await seedAuthTemplate(ctx, number.wabaId, fake);
    key = await apiKeyWithScopes(ctx, admin, ['otp.send']);
    const saved = await admin.agent.put('/api/otp/settings').set('X-CSRF-Token', admin.csrf).send({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 10, limitWindowMinutes: 15 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const endpoint = await admin.agent
      .post('/api/webhook-endpoints')
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: uniq('Leak hook '), url: `https://${uniq('leak')}.example.test/hooks`, eventTypes: ['otp.status'] });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    endpointId = endpoint.body.id as string;
    ctx.app.get(OutboundEvents).invalidate();
    for (const method of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      const original = Logger.prototype[method] as (...args: unknown[]) => void;
      vi.spyOn(Logger.prototype, method).mockImplementation(function (this: Logger, ...args: unknown[]) {
        // inspect copes with circular values, so the spy never breaks the code that logs.
        logs.push(inspect(args, { depth: 8, breakLength: Infinity }));
        return original.apply(this, args);
      });
    }
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    nock.cleanAll();
    restoreNetwork();
    await queue().obliterate({ force: true }).catch(() => undefined);
    await ctx.prisma.webhookEndpoint.delete({ where: { id: endpointId } }).catch(() => undefined);
    await ctx.close();
  });

  it('keeps no code anywhere after a success, a failure, a retry and an idempotent repeat', async () => {
    const started = new Date();
    const ok = await sendCode(ctx, key, { to: uaePhone(), code: codes.ok });
    expect(ok.status, JSON.stringify(ok.body)).toBe(202);
    expect((await run(ok.body.id)).result).toBe('sent');

    fake.failSends.set(number.phoneNumberId, { status: 400, code: 131026, message: 'Message undeliverable' });
    const failed = await sendCode(ctx, key, { to: uaePhone(), code: codes.failed });
    expect((await run(failed.body.id)).result).toBe('failed');

    fake.failSends.set(number.phoneNumberId, { status: 500, code: 131000, message: 'Something went wrong' });
    const retried = await sendCode(ctx, key, { to: uaePhone(), code: codes.retried });
    expect((await run(retried.body.id, 1)).result).toBe('retry');
    fake.failSends.delete(number.phoneNumberId);
    expect((await run(retried.body.id, 2)).result).toBe('sent');

    const phone = uaePhone();
    const idem = `leak-${digits(8)}`;
    const first = await sendCode(ctx, key, { to: phone, code: codes.repeated }, idem);
    const again = await sendCode(ctx, key, { to: phone, code: codes.repeated }, idem);
    expect(again.body.id).toBe(first.body.id);
    expect((await run(first.body.id)).result).toBe('sent');

    // The codes did reach Meta, so the scan looks for real values.
    for (const code of [codes.ok, codes.retried, codes.repeated]) expect(JSON.stringify(fake.sends)).toContain(code);

    // While the jobs wait, Redis holds only the encrypted code.
    const waiting = await redisData();
    expect(waiting.some(([, text]) => text.includes('codeEnc'))).toBe(true);

    // A real worker finishes the jobs (their messages are final, so nothing is sent again) and BullMQ deletes them.
    const ids = [ok, failed, retried, first].map((r) => r.body.id as string);
    const registry = new ProcessorRegistry(redisOptionsFromUrl(process.env.REDIS_URL ?? 'redis://localhost:6379'));
    const manager = new SendQueueManager(registry, ctx.app.get(QueueRegistry), ctx.app.get(PrismaService), ctx.app.get(SendProcessor));
    registry.onApplicationBootstrap();
    const gone = async () => (await Promise.all(ids.map((id) => queue().getJob(sendJobId(id))))).every((job) => !job);
    try {
      await manager.ensureWorker(number.id, 80);
      for (let i = 0; i < 100 && !(await gone()); i++) await new Promise((resolve) => setTimeout(resolve, 200));
    } finally {
      await registry.onModuleDestroy();
    }
    expect(await gone()).toBe(true);
    expect(fake.sends.filter((s) => s.phoneNumberId === number.phoneNumberId)).toHaveLength(3);

    const haystacks: Array<[string, string]> = [
      ['messages', JSON.stringify(await ctx.prisma.message.findMany({ where: { id: { in: ids } } }))],
      ['message events', JSON.stringify(await ctx.prisma.messageEvent.findMany({ where: { messageId: { in: ids } } }))],
      ['idempotency records', JSON.stringify(await ctx.prisma.idempotencyRecord.findMany({ where: { messageId: { in: ids } } }))],
      ['audit entries', JSON.stringify(await ctx.prisma.auditLog.findMany({ where: { createdAt: { gte: started } } }))],
      ['outbound events', JSON.stringify(await ctx.prisma.outboundEvent.findMany({ where: { createdAt: { gte: started } } }))],
      ['logs', logs.join('\n')],
      ...waiting,
      ...(await redisData()),
    ];
    expect(haystacks.find(([where]) => where === 'outbound events')![1]).toContain('otp.status');
    for (const code of Object.values(codes)) {
      for (const [where, text] of haystacks) expect(text.includes(code), `${code} found in ${where}`).toBe(false);
    }
  });
});
