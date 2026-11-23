import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 005 contract tests (T017 and later stories): responses match contracts/growth-api.openapi.yaml.
describe('Campaign growth API contract', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let numberId: string;
  let wabaId: string;
  const base = process.env.PUBLIC_LINK_BASE_URL as string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('growth-api.openapi.yaml', method, route, res.status, res.body);
  };
  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    const number = await seedNumber(ctx);
    numberId = number.id;
    wabaId = number.wabaId;
    manager = await signIn(ctx, 'MANAGER');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('US1: tracked links, clicks and the public redirect', async () => {
    await check('get', '/tracked-links/config', await call('get', '/tracked-links/config'), 200);

    const template = await seedTemplate(ctx, wabaId, {
      components: [
        { type: 'BODY', text: 'Hi {{1}}' },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Shop', url: `${base}/{{1}}`, example: [`${base}/AbCdEf1234`] }] },
      ],
      variables: [
        { key: 'BODY.1', example: 'Sara' },
        { key: 'BUTTON.0.1', example: `${base}/AbCdEf1234` },
      ],
    });
    const tag = uniq('contract');
    const contact = await seedContact(ctx, uaePhone());
    await ctx.prisma.contactTag.create({ data: { contact: { connect: { id: contact.id } }, tag: { create: { name: tag } } } });
    const draft = await call('post', '/campaigns', {
      name: `Contract clicks ${randomUUID().slice(0, 6)}`,
      numberId,
      templateId: template.id,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
    });
    const id = draft.body.id as string;

    await check('get', '/campaigns/{id}/tracked-links', await call('get', `/campaigns/${id}/tracked-links`), 200);
    await check('get', '/campaigns/{id}/tracked-links', await call('get', `/campaigns/${randomUUID()}/tracked-links`), 404);
    await check('put', '/campaigns/{id}/tracked-links', await call('put', `/campaigns/${id}/tracked-links`, { links: [{ variableKey: 'BODY.1', destination: 'ftp://x' }] }), 422);
    const saved = await call('put', `/campaigns/${id}/tracked-links`, { links: [{ variableKey: 'BUTTON.0.1', destination: 'https://shop.example/sale', addCampaignTags: true }] });
    await check('put', '/campaigns/{id}/tracked-links', saved, 200);
    const targetId = (saved.body.links as Array<{ id: string }>)[0]!.id;
    await check('patch', '/tracked-link-targets/{id}', await call('patch', `/tracked-link-targets/${targetId}`, { destination: 'https://shop.example/sale2' }), 200);
    await check('patch', '/tracked-link-targets/{id}', await call('patch', `/tracked-link-targets/${targetId}`, { destination: 'nope' }), 422);
    await check('patch', '/tracked-link-targets/{id}', await call('patch', `/tracked-link-targets/${randomUUID()}`, { destination: 'https://shop.example/x' }), 404);

    expect((await call('post', `/campaigns/${id}/launch`, {})).status).toBe(200);
    await check('put', '/campaigns/{id}/tracked-links', await call('put', `/campaigns/${id}/tracked-links`, { links: [] }), 409);

    const link = await ctx.prisma.trackedLink.findFirstOrThrow({ where: { message: { campaignId: id } } });
    const opened = await request(ctx.server()).get(`/l/${link.code}`).set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) Mobile/15E148 Safari/604.1');
    await check('get', '/l/{code}', opened, 302);
    await check('get', '/l/{code}', await request(ctx.server()).get('/l/ZZZZZZZZZZ'), 404);

    await check('get', '/campaigns/{id}/clicks/summary', await call('get', `/campaigns/${id}/clicks/summary`), 200);
    await check('get', '/campaigns/{id}/clicks/summary', await call('get', `/campaigns/${randomUUID()}/clicks/summary`), 404);
    await check('get', '/campaigns/{id}/clicks', await call('get', `/campaigns/${id}/clicks?page=1&pageSize=20`), 200);
    await check('get', '/campaigns/{id}/clicks/export', await call('get', `/campaigns/${id}/clicks/export`), 200);
    await check('get', '/campaigns/{id}/clicks/export', await call('get', `/campaigns/${randomUUID()}/clicks/export`), 404);
  });
});
