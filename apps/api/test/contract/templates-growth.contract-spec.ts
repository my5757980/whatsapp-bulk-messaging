import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { digits, restoreNetwork, seedNumber, seedTemplate, useNockLocalOnly } from '../support/fixtures.js';
import { seedAuthTemplate } from '../support/templates.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// Feature 009 contract tests: the dashboard routes match contracts/templates-growth-api.openapi.yaml.
// Each story adds its cases (T022 US1, T032 US2, T051 US4, T060 US5, T068 US6, T083 US8).
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('Templates and growth API (009) contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let fake: FakeTemplatesGraph;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('templates-growth-api.openapi.yaml', method, route, res.status, res.body);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
    fake = new FakeTemplatesGraph().install();
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await ctx.close();
  });

  describe('US1 one-time code settings', () => {
    it('GET and PUT /otp/settings', async () => {
      const template = await seedAuthTemplate(ctx, number.wabaId, fake);
      await check('get', '/otp/settings', await manager.agent.get('/api/otp/settings'), 200);
      const put = (body: object) => admin.agent.put('/api/otp/settings').set('X-CSRF-Token', admin.csrf).send(body);
      await check('put', '/otp/settings', await put({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 5, limitWindowMinutes: 15 }), 200);
      await check('put', '/otp/settings', await put({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 0, limitWindowMinutes: 15 }), 422);
    });
  });

  describe('US2 carousel card media', () => {
    it('POST /campaigns/{id}/media-check', async () => {
      const upload = async () => {
        const res = await manager.agent.post('/api/media').set('X-CSRF-Token', manager.csrf).field('purpose', 'TEMPLATE_SAMPLE').attach('file', PNG, { filename: 'card.png', contentType: 'image/png' });
        expect(res.status).toBe(201);
        return res.body.id as string;
      };
      const samples = [await upload(), await upload()];
      const card = { components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: 'Card {{1}}' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'More' }] }] };
      const template = await seedTemplate(ctx, number.wabaId, {
        category: 'MARKETING',
        kind: 'CAROUSEL',
        components: [{ type: 'BODY', text: 'Hi' }, { type: 'CAROUSEL', cards: [card, card] }],
        variables: [{ key: 'CARD.0.BODY.1', example: '1' }, { key: 'CARD.1.BODY.1', example: '2' }],
        options: { cardMediaFormat: 'IMAGE', cards: samples.map((sampleMediaAssetId) => ({ sampleMediaAssetId })) },
      });
      const draft = await manager.agent
        .post('/api/campaigns')
        .set('X-CSRF-Token', manager.csrf)
        .send({ name: `Cards ${digits(5)}`, numberId: number.id, templateId: template.id, audienceType: 'ALL_OPTED_IN', cardMedia: [{ cardIndex: 1, mediaAssetId: await upload() }] });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      const res = await manager.agent.post(`/api/campaigns/${draft.body.id}/media-check`).set('X-CSRF-Token', manager.csrf);
      await check('post', '/campaigns/{id}/media-check', res, 200);
      expect(res.body.cardMedia).toEqual([expect.objectContaining({ cardIndex: 0, result: 'READY' }), expect.objectContaining({ cardIndex: 1, result: 'READY' })]);
      await ctx.prisma.campaign.update({ where: { id: draft.body.id }, data: { state: 'COMPLETED' } });
      await check('post', '/campaigns/{id}/media-check', await manager.agent.post(`/api/campaigns/${draft.body.id}/media-check`).set('X-CSRF-Token', manager.csrf), 409);
    });
  });

  describe('US8 website button and generator', () => {
    it('the /chat-widgets routes, /tools/whatsapp-link and the public config', async () => {
      const send = (method: 'post' | 'put' | 'delete', url: string, body?: object) => manager.agent[method](`/api${url}`).set('X-CSRF-Token', manager.csrf).send(body ?? {});
      const input = (name: string) => ({
        name,
        numberId: number.id,
        look: { colour: '#0A7B55', buttonText: 'Chat with us', corner: 'BOTTOM_RIGHT', offsetX: 20, offsetY: 20, radius: 24 },
        brandName: 'Lamp & Co',
        brandImageAssetId: null,
        greeting: 'Hi!',
        message: 'Hello',
        rules: [{ match: 'PREFIX', value: '/products', hide: false, greeting: 'About this product?', message: 'Hi about a product' }],
      });
      const name = `Contract button ${digits(6)}`;
      const created = await send('post', '/chat-widgets', input(name));
      await check('post', '/chat-widgets', created, 201);
      await check('post', '/chat-widgets', await send('post', '/chat-widgets', input(name)), 409);
      await check('get', '/chat-widgets', await manager.agent.get('/api/chat-widgets'), 200);
      await check('get', '/chat-widgets/{id}', await manager.agent.get(`/api/chat-widgets/${created.body.id}`), 200);
      await check('put', '/chat-widgets/{id}', await send('put', `/chat-widgets/${created.body.id}`, input(name)), 200);
      await check('post', '/chat-widgets/{id}/pause', await send('post', `/chat-widgets/${created.body.id}/pause`), 200);
      await check('post', '/chat-widgets/{id}/resume', await send('post', `/chat-widgets/${created.body.id}/resume`), 200);
      await check('get', '/chat-widgets/{id}/stats', await manager.agent.get(`/api/chat-widgets/${created.body.id}/stats`), 200);
      await check('get', '/l/w/{key}/config.json', await request(ctx.server()).get(`/l/w/${created.body.key}/config.json`), 200);
      await check('post', '/tools/whatsapp-link', await send('post', '/tools/whatsapp-link', { phone: '+971501234567', message: 'Hi' }), 200);
      await check('post', '/tools/whatsapp-link', await send('post', '/tools/whatsapp-link', { phone: '123' }), 422);
      await check('delete', '/chat-widgets/{id}', await send('delete', `/chat-widgets/${created.body.id}`), 204);
    });
  });

  describe('US6 samples', () => {
    it('GET /template-samples, GET /template-samples/{sampleId} and POST copy', async () => {
      await check('get', '/template-samples', await manager.agent.get('/api/template-samples?industry=FOOD'), 200);
      await check('get', '/template-samples/{sampleId}', await manager.agent.get('/api/template-samples/food-order-update'), 200);
      await check('get', '/template-samples/{sampleId}', await manager.agent.get('/api/template-samples/no-such-sample'), 404);
      const copy = (name: string) => manager.agent.post('/api/template-samples/food-order-update/copy').set('X-CSRF-Token', manager.csrf).send({ wabaId: number.wabaId, name });
      const name = `food_${digits(6)}`;
      await check('post', '/template-samples/{sampleId}/copy', await copy(name), 201);
      await check('post', '/template-samples/{sampleId}/copy', await copy(name), 409);
    });
  });

  describe('US5 reports', () => {
    it('GET /reports/overview, /reports/team and /reports/consent, and RANGE_INVALID', async () => {
      const today = new Date().toISOString().slice(0, 10);
      const monthAgo = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
      const range = `from=${monthAgo}&to=${today}`;
      await check('get', '/reports/overview', await manager.agent.get(`/api/reports/overview?${range}`), 200);
      await check('get', '/reports/team', await manager.agent.get(`/api/reports/team?${range}`), 200);
      await check('get', '/reports/consent', await manager.agent.get(`/api/reports/consent?${range}&pageSize=5`), 200);
      await check('get', '/reports/overview', await manager.agent.get(`/api/reports/overview?from=${today}&to=${monthAgo}`), 422);
      const csv = await manager.agent.get(`/api/reports/consent.csv?${range}`);
      expect(csv.status).toBe(200);
      expect(csv.headers['content-type']).toMatch(/text\/csv/);
    });
  });

  describe('US4 media addresses', () => {
    it('POST /campaigns/{id}/media-check with an address problem', async () => {
      const template = await seedTemplate(ctx, number.wabaId, { components: [{ type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: 'Your invoice' }], variables: [] });
      const draft = await manager.agent
        .post('/api/campaigns')
        .set('X-CSRF-Token', manager.csrf)
        .send({ name: `Invoices ${digits(5)}`, numberId: number.id, templateId: template.id, audienceType: 'ALL_OPTED_IN', variableMapping: { 'HEADER.media': { source: 'static', value: 'http://files.example.com/invoice.pdf' } } });
      expect(draft.status, JSON.stringify(draft.body)).toBe(201);
      const res = await manager.agent.post(`/api/campaigns/${draft.body.id}/media-check`).set('X-CSRF-Token', manager.csrf);
      await check('post', '/campaigns/{id}/media-check', res, 200);
      expect(res.body).toMatchObject({ checked: 1, sampled: false, problems: [{ url: 'http://files.example.com/invoice.pdf', reason: 'NOT_HTTPS', rows: [] }], cardMedia: [] });
    });
  });
});
