import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkTagsProcessor } from '../../src/modules/contacts/bulk-tags.processor.js';
import { digits, seedContact, seedNumber, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// Feature 010 contract cases; each story adds its own (T022 and T034 for US1–US2).
describe('Contacts, settings and security API (010) contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  const tag = `contract-${digits(6)}`;
  let tagId: string;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('contacts-settings-api.openapi.yaml', method, route, res.status, res.body);
  };
  const send = (who: SignedInAgent, method: 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const rules = { groups: [{ match: 'all', rules: [{ kind: 'tag', tag, has: true }] }] };

  beforeAll(async () => {
    ctx = await createTestContext();
    [admin, manager] = await Promise.all([signIn(ctx, 'ADMIN'), signIn(ctx, 'MANAGER')]);
    tagId = (await ctx.prisma.tag.create({ data: { name: tag } })).id;
    const c = await seedContact(ctx, uaePhone());
    await ctx.prisma.contactTag.create({ data: { contactId: c.id, tagId } });
  });
  afterAll(async () => ctx.close());

  describe('US1 segments', () => {
    it('the /segments routes, a SEGMENT campaign (001) and a segment enrolment (005)', async () => {
      const name = `Contract segment ${digits(6)}`;
      const created = await send(manager, 'post', '/segments', { name, rules });
      await check('post', '/segments', created, 201);
      await check('post', '/segments', await send(manager, 'post', '/segments', { name, rules }), 409);
      await check('post', '/segments/preview', await send(manager, 'post', '/segments/preview', { rules }), 200);
      await check('get', '/segments', await manager.agent.get('/api/segments'), 200);
      await check('get', '/segments/{id}', await manager.agent.get(`/api/segments/${created.body.id}`), 200);
      await check('put', '/segments/{id}', await send(manager, 'put', `/segments/${created.body.id}`, { name, rules }), 200);
      await check('get', '/segments/{id}/count', await manager.agent.get(`/api/segments/${created.body.id}/count`), 200);
      await check('post', '/segments/{id}/copy', await send(manager, 'post', `/segments/${created.body.id}/copy`, { name: `${name} copy` }), 201);

      const number = await seedNumber(ctx);
      const template = await seedTemplate(ctx, number.wabaId);
      const campaign = await send(manager, 'post', '/campaigns', { name: 'Contract segment campaign', numberId: number.id, templateId: template.id, audienceType: 'SEGMENT', segmentId: created.body.id, variableMapping: {} });
      expect(campaign.status).toBe(201);
      await expectMatchesContract('dashboard-api.openapi.yaml', 'post', '/campaigns', 201, campaign.body);
      await check('delete', '/segments/{id}', await send(manager, 'delete', `/segments/${created.body.id}`), 409);

      const drip = await ctx.prisma.drip.create({ data: { name: `Contract drip ${digits(6)}`, numberId: number.id, status: 'ACTIVE' } });
      const enrol = await send(manager, 'post', `/drips/${drip.id}/enrolments`, { segmentId: created.body.id });
      expect(enrol.status).toBe(202);
      await expectMatchesContract('growth-api.openapi.yaml', 'post', '/drips/{id}/enrolments', 202, enrol.body);
    });
  });

  describe('US2 bulk tags, automatic tags and the export', () => {
    it('/contacts/bulk-actions, /auto-tag-rules and /contacts/export.csv', async () => {
      const vip = await ctx.prisma.tag.create({ data: { name: `contract-vip-${digits(6)}` } });
      const queued = await send(manager, 'post', '/contacts/bulk-actions', { kind: 'TAG_ADD', tagIds: [vip.id], selection: { filter: { tag: [tag] } } });
      await check('post', '/contacts/bulk-actions', queued, 202);
      await ctx.app.get(BulkTagsProcessor).run(queued.body.id);
      await check('get', '/contacts/bulk-actions/{id}', await manager.agent.get(`/api/contacts/bulk-actions/${queued.body.id}`), 200);
      await check('get', '/contacts/bulk-actions', await manager.agent.get('/api/contacts/bulk-actions'), 200);
      await check('post', '/contacts/bulk-actions', await send(manager, 'post', '/contacts/bulk-actions', { kind: 'TAG_ADD', tagIds: [], selection: { contactIds: [] } }), 422);

      const rule = await send(admin, 'post', '/auto-tag-rules', { event: 'LINK_CLICK', tagId: vip.id });
      await check('post', '/auto-tag-rules', rule, 201);
      await check('post', '/auto-tag-rules', await send(admin, 'post', '/auto-tag-rules', { event: 'LINK_CLICK', tagId: vip.id }), 409);
      await check('get', '/auto-tag-rules', await manager.agent.get('/api/auto-tag-rules'), 200);
      await check('put', '/auto-tag-rules/{id}', await send(admin, 'put', `/auto-tag-rules/${rule.body.id}`, { enabled: false }), 200);
      await check('delete', '/auto-tag-rules/{id}', await send(admin, 'delete', `/auto-tag-rules/${rule.body.id}`), 204);

      const exported = await manager.agent.get('/api/contacts/export.csv').query({ tag });
      expect(exported.status).toBe(200);
      expect(exported.headers['content-type']).toMatch(/text\/csv/);
      await check('get', '/contacts/export.csv', await manager.agent.get('/api/contacts/export.csv').query({ segmentId: '0190a000-0000-7000-8000-00000000abcd' }), 404);
    });
  });
});
