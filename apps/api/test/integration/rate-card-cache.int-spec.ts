import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { AuditService } from '../../src/modules/audit/audit.service.js';
import { RateCardService } from '../../src/modules/rate-card/rate-card.controller.js';
import { createTestContext, type TestContext } from '../support/test-context.js';

// The api and the worker each cache the rate card. The worker prices deliveries, so a change made
// through the api must reach its cache at once (the US5 e2e saw $0.00 costs from a stale cache).
describe('Rate card cache across processes', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  it('drops cached rates in every process when the card changes', async () => {
    const api = ctx.app.get(RateCardService);
    const worker = new RateCardService(ctx.prisma, ctx.app.get(AuditService), ctx.app.get<Redis>(REDIS_CLIENT));
    const card = (priceUsd: number) => [{ category: 'UTILITY' as const, countryCode: '*', priceUsd, effectiveFrom: '2026-01-01' }];

    await api.replace(card(0.01), {});
    expect((await worker.table()).rate('UTILITY', 'AE')).toBe(10_000n);

    await api.replace(card(0.02), {});
    expect((await worker.table()).rate('UTILITY', 'AE')).toBe(20_000n);
  });
});
