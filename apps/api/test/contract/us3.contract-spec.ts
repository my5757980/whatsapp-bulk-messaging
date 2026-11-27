import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { META_BASE, META_VERSION, digits, restoreNetwork, seedNumber, seedRunningCampaign, seedTemplate, useNockLocalOnly } from '../support/fixtures.js';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// T135: US3 responses match contracts/dashboard-api.openapi.yaml.
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('US3 dashboard API contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let wabaId: string;
  let numberId: string;
  let templateId: string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('dashboard-api.openapi.yaml', method, route, res.status, res.body);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
    const number = await seedNumber(ctx);
    wabaId = number.wabaId;
    numberId = number.id;
  });
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('media upload', async () => {
    const res = await admin.agent
      .post('/api/media')
      .set('x-csrf-token', admin.csrf)
      .field('purpose', 'TEMPLATE_SAMPLE')
      .attach('file', PNG, { filename: 'h.png', contentType: 'image/png' });
    await check('post', '/media', res, 201);
  });

  it('create, duplicate and delete', async () => {
    nock(META_BASE).post(`/${META_VERSION}/${wabaId}/message_templates`).reply(200, { id: 'mt-contract-1', status: 'PENDING', category: 'UTILITY' });
    const created = await admin.agent
      .post('/api/templates')
      .set('x-csrf-token', admin.csrf)
      .send({ wabaId, name: `contract_${digits(6)}`, language: 'en_US', category: 'UTILITY', body: { text: 'Your code is {{1}}.', examples: ['1234'] } });
    await check('post', '/templates', created, 201);
    templateId = created.body.id;

    const invalid = await admin.agent.post('/api/templates').set('x-csrf-token', admin.csrf).send({ wabaId, name: 'Bad Name', language: 'en_US', category: 'UTILITY', body: { text: '' } });
    await check('post', '/templates', invalid, 422);

    await check('post', '/templates/{id}/duplicate', await admin.agent.post(`/api/templates/${templateId}/duplicate`).set('x-csrf-token', admin.csrf), 201);

    nock(META_BASE).delete(`/${META_VERSION}/${wabaId}/message_templates`).query(true).reply(200, { success: true });
    await check('delete', '/templates/{id}', await admin.agent.delete(`/api/templates/${templateId}`).set('x-csrf-token', admin.csrf), 204);
  });

  it('delete conflict', async () => {
    const inUse = await seedTemplate(ctx, wabaId);
    await seedRunningCampaign(ctx, { numberId, templateId: inUse.id, createdById: admin.userId, contacts: [] });
    await check('delete', '/templates/{id}', await admin.agent.delete(`/api/templates/${inUse.id}`).set('x-csrf-token', admin.csrf), 409);
  });

  // T032 (feature 009 US2): carousel templates on the 001 template routes. Runs last: the fake Graph stays installed.
  it('carousel create and its rule errors', async () => {
    new FakeTemplatesGraph().install();
    const sample = async () => (await admin.agent.post('/api/media').set('x-csrf-token', admin.csrf).field('purpose', 'TEMPLATE_SAMPLE').attach('file', PNG, { filename: 'c.png', contentType: 'image/png' })).body.id as string;
    const card = async () => ({ mediaFormat: 'IMAGE', sampleMediaAssetId: await sample(), bodyText: 'Card {{1}}', bodyExamples: ['one'], buttons: [{ type: 'QUICK_REPLY', text: 'More' }] });
    const carousel = (cards: object[]) => ({ wabaId, name: `carousel_${digits(6)}`, language: 'en_US', category: 'MARKETING', kind: 'CAROUSEL', body: { text: 'Hi {{1}}', examples: ['Sara'] }, cards });
    const created = await admin.agent.post('/api/templates').set('x-csrf-token', admin.csrf).send(carousel([await card(), await card()]));
    await check('post', '/templates', created, 201);
    expect(created.body).toMatchObject({ kind: 'CAROUSEL', ttlSeconds: null });
    await check('post', '/templates', await admin.agent.post('/api/templates').set('x-csrf-token', admin.csrf).send(carousel([await card()])), 422);
    nock.cleanAll();
  });
});
