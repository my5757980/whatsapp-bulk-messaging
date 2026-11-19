import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImportProcessor } from '../../src/modules/imports/import.processor.js';
import { csvFile, digits, setDefaultCountry } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// T118: US2 responses match contracts/dashboard-api.openapi.yaml.
describe('US2 dashboard API contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  const s = digits(4);
  const ids: Record<string, string> = {};

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('dashboard-api.openapi.yaml', method, route, res.status, res.body);
  };
  const send = (method: 'post' | 'patch' | 'delete', path: string, body?: unknown) =>
    admin.agent[method](path).set('x-csrf-token', admin.csrf).send(body as object);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    await setDefaultCountry(ctx, 'AE');
  });
  afterAll(async () => ctx.close());

  it('attributes and tags', async () => {
    const attr = await send('post', '/api/attributes', { key: `city_${s}`, label: 'City', type: 'TEXT' });
    await check('post', '/attributes', attr, 201);
    ids.attribute = attr.body.id;
    await check('get', '/attributes', await admin.agent.get('/api/attributes'), 200);
    await check('patch', '/attributes/{id}', await send('patch', `/api/attributes/${ids.attribute}`, { label: 'Town' }), 200);

    const tag = await send('post', '/api/tags', { name: `contract-${s}` });
    await check('post', '/tags', tag, 201);
    ids.tag = tag.body.id;
    await check('get', '/tags', await admin.agent.get('/api/tags'), 200);
    await check('post', '/tags', await send('post', '/api/tags', { name: `contract-${s}` }), 409);
  });

  it('contacts', async () => {
    const created = await send('post', '/api/contacts', {
      phone: `+97150777${s}`,
      name: 'Contract Contact',
      tags: [`contract-${s}`],
      attributes: { [`city_${s}`]: 'Dubai' },
      consentStatus: 'OPTED_IN',
      consentSourceNote: 'Contract test',
    });
    await check('post', '/contacts', created, 201);
    ids.contact = created.body.id;
    await check('get', '/contacts', await admin.agent.get('/api/contacts').query({ tag: `contract-${s}` }), 200);
    await check('get', '/contacts/{id}', await admin.agent.get(`/api/contacts/${ids.contact}`), 200);
    await check('patch', '/contacts/{id}', await send('patch', `/api/contacts/${ids.contact}`, { name: 'Renamed' }), 200);
    await check('post', '/contacts/bulk', await send('post', '/api/contacts/bulk', { contactIds: [ids.contact], action: 'REMOVE_TAG', tag: `contract-${s}` }), 200);
    await check(
      'post',
      '/contacts/audience-preview',
      await send('post', '/api/contacts/audience-preview', { filter: { all: [{ attr: `city_${s}`, op: 'eq', value: 'Dubai' }] }, templateCategory: 'UTILITY' }),
      200,
    );
    await check('post', '/contacts', await send('post', '/api/contacts', { phone: 'not a phone' }), 422);
  });

  it('imports', async () => {
    const res = await admin.agent
      .post('/api/imports')
      .set('x-csrf-token', admin.csrf)
      .field('mapping', JSON.stringify({ phone: 'phone', name: 'name' }))
      .attach('file', csvFile(['phone,name', `+97150778${s},Imported`, 'bad,Row']), { filename: 'c.csv', contentType: 'text/csv' });
    await check('post', '/imports', res, 202);
    await ctx.app.get(ImportProcessor).process(res.body.id);
    await check('get', '/imports/{id}', await admin.agent.get(`/api/imports/${res.body.id}`), 200);
    const errors = await admin.agent.get(`/api/imports/${res.body.id}/errors`);
    expect(errors.status).toBe(200);
    expect(errors.headers['content-type']).toMatch(/text\/csv/);
  });

  it('deletes tags and attributes', async () => {
    await check('delete', '/tags/{id}', await send('delete', `/api/tags/${ids.tag}`), 204);
    await check('delete', '/attributes/{id}', await send('delete', `/api/attributes/${ids.attribute}`), 204);
  });
});
