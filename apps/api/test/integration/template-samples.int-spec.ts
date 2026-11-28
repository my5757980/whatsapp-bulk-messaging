import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedNumber } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T067 (feature 009 US6, research R13): the sample library, filtered and searched, copied into drafts.
describe('Template samples (009 US6)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let wabaId: string;

  const copy = (who: SignedInAgent, id: string, body: object) => who.agent.post(`/api/template-samples/${id}/copy`).set('x-csrf-token', who.csrf).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    wabaId = (await seedNumber(ctx)).wabaId;
  });
  afterAll(async () => ctx.close());

  it('filters by industry, purpose, type and language, and searches', async () => {
    const all = await agent.agent.get('/api/template-samples');
    expect(all.status).toBe(200);
    expect(all.body.items.length).toBeGreaterThanOrEqual(60);
    const food = await agent.agent.get('/api/template-samples?industry=FOOD&purpose=ORDER_UPDATE&language=en');
    expect(food.body.items.map((s: { id: string }) => s.id)).toEqual(['food-order-update']);
    const arabic = await agent.agent.get('/api/template-samples?language=ar');
    expect(arabic.body.items.length).toBeGreaterThanOrEqual(10);
    const carousels = await agent.agent.get('/api/template-samples?type=CAROUSEL');
    expect(carousels.body.items.every((s: { draft: { kind: string } }) => s.draft.kind === 'CAROUSEL')).toBe(true);
    expect((await agent.agent.get('/api/template-samples?search=tenancy')).body.items.map((s: { id: string }) => s.id)).toEqual(['real-estate-contract']);
    expect((await agent.agent.get('/api/template-samples?industry=SPACE')).status).toBe(422);
    const one = await agent.agent.get('/api/template-samples/food-order-update');
    expect(one.body).toMatchObject({ id: 'food-order-update', industry: 'FOOD', category: 'UTILITY', type: 'TEXT' });
    expect((await agent.agent.get('/api/template-samples/no-such-sample')).status).toBe(404);
  });

  it('copies a sample into a draft with its content, audited; a used name is NAME_TAKEN; agents cannot copy', async () => {
    const name = `order_update_${digits(6)}`;
    const res = await copy(manager, 'food-order-update', { wabaId, name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), status: 'DRAFT' });
    const draft = await ctx.prisma.template.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(draft).toMatchObject({ wabaId, name, language: 'en_US', category: 'UTILITY', status: 'DRAFT', metaTemplateId: null, kind: 'STANDARD' });
    expect(JSON.stringify(draft.components)).toContain('is being prepared');
    expect((draft.variables as Array<{ key: string }>).map((v) => v.key)).toEqual(['BODY.1', 'BODY.2', 'BODY.3']);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'template_sample.copied', targetId: res.body.id } })).toBe(1);

    // The editor opens the draft with the sample's text and examples.
    const prefill = await manager.agent.post(`/api/templates/${res.body.id}/duplicate`).set('x-csrf-token', manager.csrf);
    expect(prefill.body).toMatchObject({ name, body: { text: expect.stringContaining('is being prepared'), examples: ['Omar', '#3381', '25'] } });

    const taken = await copy(manager, 'food-order-update', { wabaId, name });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('NAME_TAKEN');
    expect((await copy(manager, 'food-order-update', { wabaId: 'WABA_UNKNOWN', name: `x_${digits(6)}` })).status).toBe(422);
    expect((await copy(manager, 'food-order-update', { wabaId, name: 'Bad Name' })).status).toBe(422);
    expect((await copy(agent, 'food-order-update', { wabaId, name: `y_${digits(6)}` })).status).toBe(403);
  });

  it('copies media, carousel, offer and code samples as drafts that still need their files', async () => {
    for (const [id, kind] of [['food-welcome', 'STANDARD'], ['retail-new-arrivals', 'CAROUSEL'], ['retail-weekend-deal', 'LIMITED_TIME_OFFER'], ['finance-login-code', 'AUTHENTICATION']] as const) {
      const res = await copy(manager, id, { wabaId, name: `${id.replace(/-/g, '_')}_${digits(5)}` });
      expect(res.status, `${id}: ${JSON.stringify(res.body)}`).toBe(201);
      expect((await ctx.prisma.template.findUniqueOrThrow({ where: { id: res.body.id } })).kind).toBe(kind);
    }
  });
});
