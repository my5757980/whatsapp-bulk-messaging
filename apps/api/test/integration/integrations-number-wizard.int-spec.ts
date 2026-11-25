import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../../src/common/config/config.module.js';
import type { AppConfig } from '../../src/common/config/config.js';
import { TokenCipher } from '../../src/common/crypto/token-cipher.js';
import { REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { NumberWizardService } from '../../src/modules/integrations/number-wizard/number-wizard.service.js';
import { META_BASE, META_VERSION, digits, restoreNetwork, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T079 (feature 006 US8, FR-051 - FR-055, research R13): the number connection wizard against a faked
// Graph API: a session from a token, the accounts list, checks, fixes after confirmation, the test
// message with its delivered status, connecting through the 001 service, the health check, expired
// sessions, audit entries, and the token never stored in clear.

type Json = Record<string, unknown>;

describe('Number connection wizard (006 US8)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let otherAdmin: SignedInAgent;
  let manager: SignedInAgent;
  let config: AppConfig;
  const TOKEN = `EAAGwizard${digits(24)}`;
  const WABA = `WABA${digits(10)}`;
  const PHONE = digits(15);
  const wamid = `wamid.WIZ${digits(10)}`;
  const graph = { registered: false, subscribed: false, registerCalls: 0, subscribeCalls: 0 };

  const api = (who: SignedInAgent, url: string, body?: object) => who.agent.post(`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const phoneRow = () => ({
    id: PHONE,
    display_phone_number: '+971 4 555 0199',
    verified_name: 'Acme Wizard',
    name_status: 'APPROVED',
    status: 'CONNECTED',
    code_verification_status: 'VERIFIED',
    quality_rating: 'GREEN',
    platform_type: graph.registered ? 'CLOUD_API' : 'NOT_APPLICABLE',
    throughput: { level: 'STANDARD' },
    whatsapp_business_manager_messaging_limit: 'TIER_1K',
  });
  const byName = (checks: Array<{ check: string }>) => Object.fromEntries(checks.map((c) => [c.check, c]));

  function fakeGraph(): void {
    const v = `/${META_VERSION}`;
    const appToken = `${config.META_APP_ID}|${config.META_APP_SECRET}`;
    nock(META_BASE)
      .persist()
      .get(`${v}/debug_token`)
      .query(true)
      .matchHeader('authorization', `Bearer ${appToken}`)
      .reply(async (request: Request) => {
        const input = new URL(request.url).searchParams.get('input_token');
        if (input !== TOKEN) return [200, { data: { is_valid: false, scopes: [], error: { code: 190, message: 'Invalid OAuth access token.' } } }];
        return [
          200,
          {
            data: {
              app_id: config.META_APP_ID,
              type: 'SYSTEM_USER',
              is_valid: true,
              expires_at: 0,
              scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
              granular_scopes: [
                { scope: 'whatsapp_business_management', target_ids: [WABA] },
                { scope: 'whatsapp_business_messaging', target_ids: [WABA] },
              ],
            },
          },
        ];
      });
    nock(META_BASE).persist().get(`${v}/${WABA}`).query(true).reply(200, { id: WABA, name: 'Acme account', currency: 'AED', timezone_id: '102' });
    nock(META_BASE)
      .persist()
      .get(`${v}/${WABA}/phone_numbers`)
      .query(true)
      .reply(async () => [200, { data: [phoneRow()] }]);
    nock(META_BASE)
      .persist()
      .get(`${v}/${PHONE}`)
      .query(true)
      .reply(async () => [200, phoneRow()]);
    nock(META_BASE)
      .persist()
      .post(`${v}/${PHONE}/register`)
      .reply(async (request: Request) => {
        graph.registerCalls += 1;
        const body = (await request.json()) as { pin?: string; messaging_product?: string };
        if (body.pin !== '123456' || body.messaging_product !== 'whatsapp') return [400, { error: { message: 'Two step verification PIN Mismatch', code: 133005 } }];
        graph.registered = true;
        return [200, { success: true }];
      });
    nock(META_BASE)
      .persist()
      .get(`${v}/${WABA}/subscribed_apps`)
      .reply(async () => [200, { data: graph.subscribed ? [{ whatsapp_business_api_data: { id: config.META_APP_ID, name: 'Company app' } }] : [] }]);
    nock(META_BASE)
      .persist()
      .post(`${v}/${WABA}/subscribed_apps`)
      .reply(async () => {
        graph.subscribeCalls += 1;
        graph.subscribed = true;
        return [200, { success: true }];
      });
    nock(META_BASE)
      .persist()
      .get(`${v}/${config.META_APP_ID}/subscriptions`)
      .matchHeader('authorization', `Bearer ${appToken}`)
      .reply(200, { data: [{ object: 'whatsapp_business_account', callback_url: `${config.APP_URL.replace(/\/+$/, '')}/api/webhooks/meta`, active: true, fields: [{ name: 'messages' }] }] });
    nock(META_BASE)
      .persist()
      .get(`${v}/${WABA}/message_templates`)
      .query(true)
      .reply(200, { data: [{ id: 'T1', name: 'hello_world', language: 'en_US', status: 'APPROVED', category: 'UTILITY', components: [{ type: 'BODY', text: 'Hello World' }] }] });
    nock(META_BASE)
      .persist()
      .post(`${v}/${PHONE}/messages`)
      .reply(async (request: Request) => {
        const body = (await request.json()) as { template?: { name?: string } };
        return body.template?.name === 'hello_world' ? [200, { messages: [{ id: wamid }] }] : [400, { error: { message: 'Unexpected template', code: 132001 } }];
      });
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    otherAdmin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    config = ctx.app.get<AppConfig>(APP_CONFIG);
    NumberWizardService.deliveryWaitMs = 15_000;
    fakeGraph();
  });

  afterAll(async () => {
    NumberWizardService.deliveryWaitMs = 60_000;
    nock.cleanAll();
    restoreNetwork();
    await ctx.close();
  });

  let session: Json;

  it('checks the token and lists the accounts and numbers it reaches, keeping the token encrypted', async () => {
    expect((await api(manager, '/number-wizard/sessions', { accessToken: TOKEN })).status).toBe(403);
    const bad = await api(admin, '/number-wizard/sessions', { accessToken: `EAAGnot-valid-${digits(12)}` });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('TOKEN_INVALID');

    const res = await api(admin, '/number-wizard/sessions', { accessToken: TOKEN });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    session = res.body as Json;
    expect(session.token).toMatchObject({ result: 'PASSED' });
    expect(session.accounts).toEqual([
      { wabaId: WABA, name: 'Acme account', businessName: null, numbers: [{ phoneNumberId: PHONE, displayPhoneNumber: '+971 4 555 0199', verifiedName: 'Acme Wizard', alreadyConnected: false }] },
    ]);
    const redis = ctx.app.get<Redis>(REDIS_CLIENT);
    const stored = await redis.get(`wbm:wizard:${String(session.id)}`);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(TOKEN);
    expect(await redis.ttl(`wbm:wizard:${String(session.id)}`)).toBeGreaterThan(1700);
  });

  it('runs every check, applies fixes only when asked, and checks again', async () => {
    const id = String(session.id);
    const first = await api(admin, `/number-wizard/sessions/${id}/checks`, { wabaId: WABA, phoneNumberId: PHONE });
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.ready).toBe(false);
    const checks = byName(first.body.checks);
    expect(Object.keys(checks).sort()).toEqual(['APP_SUBSCRIBED', 'DISPLAY_NAME', 'MESSAGING_LIMIT', 'NUMBER_REGISTERED', 'QUALITY', 'TOKEN_EXPIRY', 'TOKEN_PERMISSIONS', 'TOKEN_VALID', 'TWO_STEP_PIN', 'WEBHOOK_CALLBACK']);
    expect(checks.NUMBER_REGISTERED).toMatchObject({ result: 'FAILED', fixAction: 'REGISTER_NUMBER' });
    expect(checks.APP_SUBSCRIBED).toMatchObject({ result: 'FAILED', fixAction: 'SUBSCRIBE_APP' });
    expect(checks.WEBHOOK_CALLBACK).toMatchObject({ result: 'PASSED' });
    expect(graph.registerCalls + graph.subscribeCalls).toBe(0);

    const wrongPin = await api(admin, `/number-wizard/sessions/${id}/fixes`, { fix: 'REGISTER_NUMBER', wabaId: WABA, phoneNumberId: PHONE, pin: '000000' });
    expect(wrongPin.status).toBe(422);
    expect(wrongPin.body.code).toBe('FIX_FAILED');
    expect((await api(admin, `/number-wizard/sessions/${id}/fixes`, { fix: 'REGISTER_NUMBER', wabaId: WABA, phoneNumberId: PHONE })).status).toBe(422);
    const registered = await api(admin, `/number-wizard/sessions/${id}/fixes`, { fix: 'REGISTER_NUMBER', wabaId: WABA, phoneNumberId: PHONE, pin: '123456' });
    expect(registered.status).toBe(200);
    expect(byName(registered.body.checks).NUMBER_REGISTERED).toMatchObject({ result: 'PASSED' });
    const subscribed = await api(admin, `/number-wizard/sessions/${id}/fixes`, { fix: 'SUBSCRIBE_APP', wabaId: WABA, phoneNumberId: PHONE });
    expect(subscribed.status).toBe(200);
    expect(subscribed.body.ready).toBe(true);

    const fixes = await ctx.prisma.auditLog.findMany({ where: { action: 'number.fixed_with_wizard', actorUserId: admin.userId } });
    expect(fixes.map((a) => (a.metadata as { fix: string }).fix).sort()).toEqual(['REGISTER_NUMBER', 'SUBSCRIBE_APP']);
    expect(JSON.stringify(fixes)).not.toContain('123456');
    const rows = await ctx.prisma.numberConnectionCheck.findMany({ where: { phoneNumberId: PHONE } });
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(JSON.stringify(rows)).not.toContain(TOKEN);
  });

  it('sends the test message and sees its delivered status arrive', async () => {
    const id = String(session.id);
    const to = uaePhone();
    const pending = api(admin, `/number-wizard/sessions/${id}/test-message`, { wabaId: WABA, phoneNumberId: PHONE, to }).then((r) => r);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await postSignedWebhook(ctx, webhook.status(PHONE, wamid, to.slice(1), 'delivered'));
    const res = await pending;
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ sent: true, delivered: true, error: null });
    const latest = await ctx.prisma.numberConnectionCheck.findFirstOrThrow({ where: { phoneNumberId: PHONE }, orderBy: { createdAt: 'desc' } });
    expect((latest.results as Array<{ check: string; result: string }>).find((c) => c.check === 'TEST_MESSAGE')).toMatchObject({ result: 'PASSED' });
  });

  it('connects the number through the 001 service with the token encrypted', async () => {
    const id = String(session.id);
    const res = await api(admin, `/number-wizard/sessions/${id}/connect`, { wabaId: WABA, phoneNumberId: PHONE, label: 'Wizard number' });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const number = await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: String(res.body.id) } });
    expect(number).toMatchObject({ label: 'Wizard number', wabaId: WABA, phoneNumberId: PHONE, connectionStatus: 'CONNECTED', displayPhoneNumber: '+971 4 555 0199' });
    expect(number.accessTokenEnc).not.toContain(TOKEN);
    expect(ctx.app.get(TokenCipher).decrypt(number.accessTokenEnc)).toBe(TOKEN);
    expect(await ctx.prisma.numberConnectionCheck.count({ where: { phoneNumberId: PHONE, numberId: number.id } })).toBeGreaterThan(0);
    expect(await ctx.prisma.auditLog.findFirst({ where: { action: 'number.connected_with_wizard', targetId: number.id } })).toMatchObject({ metadata: { tested: true } });
    expect(await ctx.prisma.auditLog.findFirst({ where: { action: 'number.connected', targetId: number.id } })).toBeTruthy();
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: { startsWith: 'number.' }, actorUserId: admin.userId } });
    expect(JSON.stringify(audits)).not.toContain(TOKEN);

    // The session is closed, and a new one shows the number as connected.
    expect((await api(admin, `/number-wizard/sessions/${id}/connect`, { wabaId: WABA, phoneNumberId: PHONE, label: 'Again' })).status).toBe(404);
    const again = await api(admin, '/number-wizard/sessions', { accessToken: TOKEN });
    expect((again.body.accounts as Array<{ numbers: Array<{ alreadyConnected: boolean }> }>)[0]!.numbers[0]!.alreadyConnected).toBe(true);
    const exists = await api(admin, `/number-wizard/sessions/${String(again.body.id)}/connect`, { wabaId: WABA, phoneNumberId: PHONE, label: 'Again', withoutTest: true });
    expect(exists.status).toBe(409);
    expect(exists.body.code).toBe('NUMBER_EXISTS');
    const untested = await api(admin, `/number-wizard/sessions/${String(again.body.id)}/connect`, { wabaId: WABA, phoneNumberId: digits(15), label: 'Untested' });
    expect(untested.status).toBe(422);
    expect(untested.body.code).toBe('TEST_NOT_SENT');
  });

  it('runs the health check on a connected number without changing it', async () => {
    const number = await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { phoneNumberId: PHONE } });
    const calls = graph.registerCalls + graph.subscribeCalls;
    const res = await api(admin, `/numbers/${number.id}/health-check`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.ready).toBe(true);
    expect(graph.registerCalls + graph.subscribeCalls).toBe(calls);
    expect(await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: number.id } })).toEqual(number);
    expect(await ctx.prisma.numberConnectionCheck.count({ where: { numberId: number.id, runById: admin.userId } })).toBeGreaterThan(1);
    expect((await api(admin, `/numbers/${randomUUID()}/health-check`)).status).toBe(404);
    expect((await api(manager, `/numbers/${number.id}/health-check`)).status).toBe(403);
  });

  it('answers 404 for an expired, unknown or another admin session', async () => {
    const fresh = await api(admin, '/number-wizard/sessions', { accessToken: TOKEN });
    const id = String(fresh.body.id);
    const ref = { wabaId: WABA, phoneNumberId: PHONE };
    expect((await api(otherAdmin, `/number-wizard/sessions/${id}/checks`, ref)).status).toBe(404);
    expect((await api(admin, `/number-wizard/sessions/${randomUUID()}/checks`, ref)).status).toBe(404);
    expect((await api(admin, `/number-wizard/sessions/${id}/checks`, { wabaId: 'WABA-OTHER', phoneNumberId: PHONE })).status).toBe(422);
    await ctx.app.get<Redis>(REDIS_CLIENT).del(`wbm:wizard:${id}`);
    expect((await api(admin, `/number-wizard/sessions/${id}/checks`, ref)).status).toBe(404);
  });
});
