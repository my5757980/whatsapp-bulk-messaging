import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/common/auth/totp.js';
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

  describe('US3 global attributes', () => {
    it('the /global-attributes routes', async () => {
      const key = `contract_${digits(6)}`;
      const created = await send(admin, 'post', '/global-attributes', { key, description: 'Contract value', value: 'one' });
      await check('post', '/global-attributes', created, 201);
      await check('post', '/global-attributes', await send(admin, 'post', '/global-attributes', { key, value: 'two' }), 409);
      await check('post', '/global-attributes', await send(admin, 'post', '/global-attributes', { key: 'Not A Key', value: 'x' }), 422);
      await check('get', '/global-attributes', await manager.agent.get('/api/global-attributes'), 200);
      await check('put', '/global-attributes/{id}', await send(admin, 'put', `/global-attributes/${created.body.id}`, { description: null, value: 'two' }), 200);
      await check('put', '/global-attributes/{id}', await send(admin, 'put', '/global-attributes/0190a000-0000-7000-8000-00000000abcd', { value: 'x' }), 404);

      const reply = await send(admin, 'post', '/canned-messages', { name: `Contract reply ${digits(6)}`, type: 'TEXT', text: `Value {global:${key}}` });
      expect(reply.status).toBe(201);
      await check('get', '/global-attributes/{id}/usage', await admin.agent.get(`/api/global-attributes/${created.body.id}/usage`), 200);
      await check('delete', '/global-attributes/{id}', await send(admin, 'delete', `/global-attributes/${created.body.id}`), 409);
      await send(admin, 'delete', `/canned-messages/${reply.body.id}`);
      await check('delete', '/global-attributes/{id}', await send(admin, 'delete', `/global-attributes/${created.body.id}`), 204);
      await check('delete', '/global-attributes/{id}', await send(admin, 'delete', `/global-attributes/${created.body.id}`), 404);
    });
  });

  describe('US4 keyword replies', () => {
    it('/settings/keyword-replies', async () => {
      await check('get', '/settings/keyword-replies', await manager.agent.get('/api/settings/keyword-replies'), 200);
      const number = await seedNumber(ctx);
      const marketing = await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' });
      const utility = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' });
      const refused = await send(admin, 'put', '/settings/keyword-replies', { optOut: { kind: 'NONE' }, optIn: { kind: 'TEMPLATE', templateId: marketing.id, variables: { 'BODY.1': { source: 'static', value: 'friend' } } } });
      await check('put', '/settings/keyword-replies', refused, 422);
      expect(refused.body.code).toBe('TEMPLATE_NOT_UTILITY');
      await check(
        'put',
        '/settings/keyword-replies',
        await send(admin, 'put', '/settings/keyword-replies', { optOut: { kind: 'TEXT', text: 'You are unsubscribed.' }, optIn: { kind: 'TEMPLATE', templateId: utility.id, variables: { 'BODY.1': { source: 'static', value: 'friend' } } } }),
        200,
      );
      await check('put', '/settings/keyword-replies', await send(admin, 'put', '/settings/keyword-replies', { optOut: { kind: 'NONE' }, optIn: { kind: 'NONE' } }), 200);
    });
  });

  describe('US5 date automations', () => {
    it('the /date-automations routes', async () => {
      const attr = await ctx.prisma.attributeDefinition.create({ data: { key: `contract_date_${digits(6)}`, label: 'Contract date', type: 'DATE' } });
      const text = await ctx.prisma.attributeDefinition.create({ data: { key: `contract_text_${digits(6)}`, label: 'Contract text', type: 'TEXT' } });
      const number = await seedNumber(ctx);
      const template = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' });
      const pending = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY', status: 'PENDING' });
      const input = { name: `Contract dates ${digits(6)}`, attributeKey: attr.key, timing: 'YEARLY', offsetDays: 0, sendTime: '09:00', numberId: number.id, templateId: template.id, variableMapping: { 'BODY.1': { source: 'field', key: 'name', fallback: 'friend' } } };

      const created = await send(manager, 'post', '/date-automations', input);
      await check('post', '/date-automations', created, 201);
      await check('post', '/date-automations', await send(manager, 'post', '/date-automations', input), 409);
      await check('post', '/date-automations', await send(manager, 'post', '/date-automations', { ...input, name: `Other ${digits(6)}`, attributeKey: text.key }), 422);
      await check('get', '/date-automations', await manager.agent.get('/api/date-automations'), 200);
      await check('get', '/date-automations/{id}', await manager.agent.get(`/api/date-automations/${created.body.id}`), 200);
      await check('put', '/date-automations/{id}', await send(manager, 'put', `/date-automations/${created.body.id}`, { ...input, sendTime: '10:00' }), 200);
      await check('post', '/date-automations/preview', await send(manager, 'post', '/date-automations/preview', { attributeKey: attr.key, timing: 'ONCE', offsetDays: -3 }), 200);
      await check('post', '/date-automations/preview', await send(manager, 'post', '/date-automations/preview', { attributeKey: text.key, timing: 'ONCE', offsetDays: 0 }), 422);
      await check('post', '/date-automations/{id}/switch', await send(manager, 'post', `/date-automations/${created.body.id}/switch`, { on: true }), 200);
      await check('post', '/date-automations/{id}/switch', await send(manager, 'post', `/date-automations/${created.body.id}/switch`, { on: false }), 200);
      const waiting = await send(manager, 'post', '/date-automations', { ...input, name: `Waiting ${digits(6)}`, templateId: pending.id });
      await check('post', '/date-automations/{id}/switch', await send(manager, 'post', `/date-automations/${waiting.body.id}/switch`, { on: true }), 409);
      await check('get', '/date-automations/{id}/results', await manager.agent.get(`/api/date-automations/${created.body.id}/results`), 200);
      await check('get', '/date-automations/{id}/results', await manager.agent.get(`/api/date-automations/${created.body.id}/results`).query({ from: '2027-01-10', to: '2027-01-01' }), 422);
      await check('get', '/date-automations/{id}/recipients', await manager.agent.get(`/api/date-automations/${created.body.id}/recipients`).query({ date: '2027-01-01' }), 200);
      await check('delete', '/date-automations/{id}', await send(manager, 'delete', `/date-automations/${waiting.body.id}`), 204);
      await check('get', '/date-automations/{id}', await manager.agent.get(`/api/date-automations/${waiting.body.id}`), 404);
      await send(manager, 'delete', `/date-automations/${created.body.id}`);
    });
  });

  describe('US6 two-factor sign-in', () => {
    it('/me/2fa*, /auth/login/*, /settings/security and /users/{id}/2fa/reset', async () => {
      const password = 'Contract-2FA-Password-1';
      const email = `contract-2fa-${digits(8)}@test.local`;
      const user = await ctx.prisma.user.create({ data: { email, name: 'Contract 2FA', role: 'AGENT', status: 'ACTIVE', passwordHash: await argon2.hash(password, { type: argon2.argon2id }) } });
      const member = request.agent(ctx.server());
      const signedIn = await member.post('/api/auth/login').send({ email, password });
      await expectMatchesContract('dashboard-api.openapi.yaml', 'post', '/auth/login', 200, signedIn.body);
      const csrfOf = (res: request.Response) => decodeURIComponent(((res.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('csrf=')) ?? 'csrf=').split(';')[0]!.slice(5));
      const csrf = csrfOf(signedIn);
      const me = (path: string, body?: object) => member.post(`/api${path}`).set('X-CSRF-Token', csrf).send(body ?? {});

      await check('get', '/me/2fa', await member.get('/api/me/2fa'), 200);
      const setup = await me('/me/2fa/setup');
      await check('post', '/me/2fa/setup', setup, 200);
      await check('post', '/me/2fa/confirm', await me('/me/2fa/confirm', { code: '000000' }), 422);
      await check('post', '/me/2fa/confirm', await me('/me/2fa/confirm', { code: totpCode(setup.body.secret, Date.now()) }), 200);
      await check('post', '/me/2fa/setup', await me('/me/2fa/setup'), 409);
      await check('post', '/me/2fa/recovery-codes', await me('/me/2fa/recovery-codes', { code: totpCode(setup.body.secret, Date.now() + 30_000) }), 200);

      const pending = request.agent(ctx.server());
      const first = await pending.post('/api/auth/login').send({ email, password });
      await expectMatchesContract('dashboard-api.openapi.yaml', 'post', '/auth/login', 200, first.body);
      expect(first.body).toEqual({ next: 'CODE' });
      await check('post', '/auth/login/code', await pending.post('/api/auth/login/code').send({ code: '000000' }), 422);
      await check('post', '/auth/login/setup', await pending.post('/api/auth/login/setup'), 401);
      await ctx.prisma.userTwoFactor.update({ where: { userId: user.id }, data: { lastStep: null } });
      await check('post', '/auth/login/code', await pending.post('/api/auth/login/code').send({ code: totpCode(setup.body.secret, Date.now()) }), 200);
      await check('post', '/auth/login/code', await pending.post('/api/auth/login/code').send({ code: '123456' }), 401);
      await check('post', '/auth/login/setup/confirm', await request(ctx.server()).post('/api/auth/login/setup/confirm').send({ code: '123456' }), 401);

      await check('get', '/settings/security', await admin.agent.get('/api/settings/security'), 200);
      await check('put', '/settings/security', await send(admin, 'put', '/settings/security', { require2fa: false }), 200);
      await check('post', '/users/{id}/2fa/reset', await send(admin, 'post', `/users/${admin.userId}/2fa/reset`), 409);
      await check('post', '/users/{id}/2fa/reset', await send(admin, 'post', '/users/0190a000-0000-7000-8000-00000000abcd/2fa/reset'), 404);
      await check('post', '/users/{id}/2fa/reset', await send(admin, 'post', `/users/${user.id}/2fa/reset`), 204);
    });
  });
});
