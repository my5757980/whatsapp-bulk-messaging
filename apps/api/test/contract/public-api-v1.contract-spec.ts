import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 006 contract tests (T027): the public API v1 additions match contracts/public-api-v1.openapi.yaml.
describe('Public API v1 (006) contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let key: string;
  let sendOnly: string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('public-api-v1.openapi.yaml', method, route, res.status, res.body);
  };
  const call = (secret: string, method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object) => {
    const req = request(ctx.server())[method](`/api/v1${url}`).set('Authorization', `Bearer ${secret}`);
    return method === 'get' ? req : req.send(body ?? {});
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    const created = await admin.agent.post('/api/api-keys').set('X-CSRF-Token', admin.csrf).send({ name: uniq('Contract '), rateLimitPerMinute: 600 });
    key = created.body.secret;
    await admin.agent.put(`/api/api-keys/${created.body.id}/scopes`).set('X-CSRF-Token', admin.csrf).send({ scopes: ['contacts.read', 'contacts.write', 'drips.enrol'] });
    sendOnly = (await admin.agent.post('/api/api-keys').set('X-CSRF-Token', admin.csrf).send({ name: uniq('Send '), rateLimitPerMinute: 600 })).body.secret;
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('US2: contacts, tags, attributes, consent and drip enrolment', async () => {
    const missing = randomUUID();
    await check('get', '/contacts', await call(key, 'get', '/contacts?limit=5'), 200);
    await check('get', '/contacts', await call(sendOnly, 'get', '/contacts'), 403);
    await check('get', '/contacts', await call('wbk_' + 'x'.repeat(32), 'get', '/contacts'), 401);
    const created = await call(key, 'post', '/contacts', { phone: uaePhone(), name: 'Contract', tags: ['contract'] });
    await check('post', '/contacts', created, 201);
    await check('post', '/contacts', await call(key, 'post', '/contacts', { phone: created.body.phone, name: 'Contract 2' }), 200);
    await check('post', '/contacts', await call(key, 'post', '/contacts', { phone: '1' }), 422);
    const id = created.body.id as string;

    await check('get', '/contacts/lookup', await call(key, 'get', `/contacts/lookup?phone=${encodeURIComponent(created.body.phone)}`), 200);
    await check('get', '/contacts/lookup', await call(key, 'get', `/contacts/lookup?phone=${encodeURIComponent(uaePhone())}`), 404);
    await check('get', '/contacts/{id}', await call(key, 'get', `/contacts/${id}`), 200);
    await check('get', '/contacts/{id}', await call(key, 'get', `/contacts/${missing}`), 404);
    await check('patch', '/contacts/{id}', await call(key, 'patch', `/contacts/${id}`, { name: 'Renamed' }), 200);
    await check('patch', '/contacts/{id}', await call(key, 'patch', `/contacts/${missing}`, { name: 'x' }), 404);
    await check('post', '/contacts/{id}/tags', await call(key, 'post', `/contacts/${id}/tags`, { tags: ['extra'] }), 200);
    await check('delete', '/contacts/{id}/tags/{tag}', await call(key, 'delete', `/contacts/${id}/tags/extra`), 200);
    await check('post', '/contacts/{id}/opt-in', await call(key, 'post', `/contacts/${id}/opt-in`, {}), 422);
    await check('post', '/contacts/{id}/opt-in', await call(key, 'post', `/contacts/${id}/opt-in`, { sourceNote: 'contract test' }), 200);
    await check('post', '/contacts/{id}/opt-out', await call(key, 'post', `/contacts/${id}/opt-out`), 200);
    await check('post', '/contacts/{id}/opt-in', await call(key, 'post', `/contacts/${id}/opt-in`, { sourceNote: 'again' }), 409);
    await check('get', '/tags', await call(key, 'get', '/tags'), 200);
    await check('get', '/attributes', await call(key, 'get', '/attributes'), 200);

    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' });
    const drip = await ctx.prisma.drip.create({ data: { name: uniq('Contract drip '), numberId: number.id, status: 'ACTIVE' } });
    await ctx.prisma.dripStep.create({ data: { dripId: drip.id, position: 1, templateId: template.id, waitMinutes: 0 } });
    const member = await seedContact(ctx, uaePhone());
    await check('post', '/drips/{drip}/enrolments', await call(key, 'post', `/drips/${drip.id}/enrolments`, { contactId: member.id }), 200);
    await check('post', '/drips/{drip}/enrolments', await call(key, 'post', `/drips/${missing}/enrolments`, { contactId: member.id }), 404);
    const paused = await ctx.prisma.drip.create({ data: { name: uniq('Paused drip '), numberId: number.id, status: 'PAUSED' } });
    await check('post', '/drips/{drip}/enrolments', await call(key, 'post', `/drips/${paused.id}/enrolments`, { contactId: member.id }), 409);
    await check('delete', '/drips/{drip}/enrolments/{contactId}', await call(key, 'delete', `/drips/${drip.id}/enrolments/${member.id}`), 204);
    await check('delete', '/drips/{drip}/enrolments/{contactId}', await call(key, 'delete', `/drips/${drip.id}/enrolments/${member.id}`), 404);
  });

  it('US3: triggering an API campaign', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY', components: [{ type: 'BODY', text: 'Order {{1}} is ready' }], variables: [{ key: 'BODY.1', example: 'A-1' }] });
    const csrf = { 'X-CSRF-Token': admin.csrf };
    const campaign = await admin.agent.post('/api/api-campaigns').set(csrf).send({ name: uniq('Trigger contract '), apiName: uniq('trigger-'), numberId: number.id, templateId: template.id, variableMapping: { 'BODY.1': { source: 'value', key: 'order' } } });
    expect((await admin.agent.post(`/api/api-campaigns/${campaign.body.id}/go-live`).set(csrf).send({})).status).toBe(200);
    const created = await admin.agent.post('/api/api-keys').set(csrf).send({ name: uniq('Trigger '), rateLimitPerMinute: 600 });
    await admin.agent.put(`/api/api-keys/${created.body.id}/scopes`).set(csrf).send({ scopes: ['campaigns.trigger'] });
    const trigger = created.body.secret as string;
    const route = '/api-campaigns/{apiName}/messages';
    const path = `/api-campaigns/${campaign.body.apiName}/messages`;
    await check('post', route, await call(trigger, 'post', path, { phone: uaePhone(), values: { order: 'A-1' } }), 202);
    await check('post', route, await call(trigger, 'post', path, { phone: uaePhone(), values: {} }), 422);
    await check('post', route, await call(trigger, 'post', '/api-campaigns/no-such-campaign/messages', { phone: uaePhone() }), 404);
    await check('post', route, await call(key, 'post', path, { phone: uaePhone(), values: { order: 'A-1' } }), 403);
    await check('post', route, await call('wbk_' + 'y'.repeat(32), 'post', path, { phone: uaePhone() }), 401);
    const optedOut = await seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_OUT' });
    await check('post', route, await call(trigger, 'post', path, { phone: optedOut.phoneE164, values: { order: 'A-1' } }), 409);
  });
});
