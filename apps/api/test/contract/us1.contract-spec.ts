import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AudienceUploadProcessor } from '../../src/modules/campaigns/audience-upload.processor.js';
import { META_BASE, META_VERSION, NUMBER_TOKEN, csvFile, digits, restoreNetwork, setDefaultCountry, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// T082: US1 responses match contracts/dashboard-api.openapi.yaml.
describe('US1 dashboard API contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  const phoneNumberId = digits(15);
  const wabaId = `WABA${digits(6)}`;
  const ids: Record<string, string> = {};

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('dashboard-api.openapi.yaml', method, route, res.status, res.body);
  };
  const send = (method: 'post' | 'patch' | 'delete', path: string) => admin.agent[method](path).set('x-csrf-token', admin.csrf);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    nock(META_BASE)
      .get(`/${META_VERSION}/${phoneNumberId}`)
      .query(true)
      .times(2)
      .reply(200, { id: phoneNumberId, display_phone_number: '+1 555 010 0002', verified_name: 'Contract Co', quality_rating: 'GREEN', throughput: { level: 'STANDARD' } })
      .get(`/${META_VERSION}/${wabaId}/message_templates`)
      .query(true)
      .matchHeader('authorization', `Bearer ${NUMBER_TOKEN}`)
      .reply(200, { data: [{ id: 'mt-c1', name: 'contract_hello', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello {{1}}' }] }] });
  });
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('numbers', async () => {
    const created = await send('post', '/api/numbers').send({ label: 'Contract', wabaId, phoneNumberId, accessToken: NUMBER_TOKEN });
    await check('post', '/numbers', created, 201);
    ids.number = created.body.id;
    await check('get', '/numbers', await admin.agent.get('/api/numbers'), 200);
    await check('get', '/numbers/{id}', await admin.agent.get(`/api/numbers/${ids.number}`), 200);
    await check('patch', '/numbers/{id}', await send('patch', `/api/numbers/${ids.number}`).send({ sendRatePerSecond: 10 }), 200);
    await check('post', '/numbers/{id}/refresh', await send('post', `/api/numbers/${ids.number}/refresh`), 200);
  });

  it('templates', async () => {
    await check('post', '/templates/sync', await send('post', '/api/templates/sync'), 200);
    const list = await admin.agent.get('/api/templates').query({ wabaId });
    await check('get', '/templates', list, 200);
    ids.template = list.body[0].id;
    await check('get', '/templates/{id}', await admin.agent.get(`/api/templates/${ids.template}`), 200);
  });

  it('campaign draft, upload, estimate, launch and messages', async () => {
    const created = await send('post', '/api/campaigns').send({ name: 'Contract campaign', numberId: ids.number, templateId: ids.template, audienceType: 'UPLOAD' });
    await check('post', '/campaigns', created, 201);
    ids.campaign = created.body.id;
    await check('get', '/campaigns', await admin.agent.get('/api/campaigns'), 200);
    await check(
      'patch',
      '/campaigns/{id}',
      await send('patch', `/api/campaigns/${ids.campaign}`).send({ variableMapping: { 'BODY.1': { source: 'column', key: 'name', fallback: null } } }),
      200,
    );

    const upload = await send('post', `/api/campaigns/${ids.campaign}/audience-upload`)
      .field('phoneColumn', 'phone')
      .field('optInConfirmed', 'true')
      .field('optInSourceNote', 'Contract test opt-in')
      .attach('file', csvFile(['name,phone', 'Nadia,+971503330001', 'Faris,+971503330002']), { filename: 'a.csv', contentType: 'text/csv' });
    await check('post', '/campaigns/{id}/audience-upload', upload, 202);
    await ctx.app.get(AudienceUploadProcessor).process(upload.body.id);
    await check('get', '/imports/{id}', await admin.agent.get(`/api/imports/${upload.body.id}`), 200);

    await check('post', '/campaigns/{id}/estimate', await send('post', `/api/campaigns/${ids.campaign}/estimate`), 200);
    await check('post', '/campaigns/{id}/launch', await send('post', `/api/campaigns/${ids.campaign}/launch`).send({}), 200);
    await check('get', '/campaigns/{id}', await admin.agent.get(`/api/campaigns/${ids.campaign}`), 200);
    await check('get', '/campaigns/{id}/messages', await admin.agent.get(`/api/campaigns/${ids.campaign}/messages`), 200);
  });

  it('pause, resume and cancel', async () => {
    await check('post', '/campaigns/{id}/pause', await send('post', `/api/campaigns/${ids.campaign}/pause`), 200);
    await check('post', '/campaigns/{id}/resume', await send('post', `/api/campaigns/${ids.campaign}/resume`), 200);
    await check('post', '/campaigns/{id}/cancel', await send('post', `/api/campaigns/${ids.campaign}/cancel`), 200);
  });

  it('errors use the documented shape', async () => {
    const res = await send('post', `/api/campaigns/${ids.campaign}/pause`);
    await check('post', '/campaigns/{id}/pause', res, 409);
    const missing = await admin.agent.get('/api/campaigns/0190a000-0000-7000-8000-000000000000');
    await check('get', '/campaigns/{id}', missing, 404);
  });

  it('contact deletion', async () => {
    const contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: '+971503330001' } });
    const res = await send('delete', `/api/contacts/${contact.id}`);
    await check('delete', '/contacts/{id}', res, 204);
  });
});
