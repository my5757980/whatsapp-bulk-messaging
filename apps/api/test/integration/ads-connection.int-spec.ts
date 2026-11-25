import type { Redis } from 'ioredis';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../../src/common/config/config.module.js';
import type { AppConfig } from '../../src/common/config/config.js';
import { TokenCipher } from '../../src/common/crypto/token-cipher.js';
import { REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { clearAds } from '../support/ads.js';
import { META_BASE, META_VERSION, digits, restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T019 (feature 007 US1, FR-001 – FR-004, FR-018, research R2): connecting the ad account and page
// against a faked Graph API: the token session, the checks with fixes, saving with the tokens
// encrypted and never returned, running the checks again, the ERROR state with admin alerts, the
// spending cap, disconnecting, expired sessions, permissions and audit entries without tokens.

type Json = Record<string, unknown>;
const ALL = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'pages_manage_metadata', 'leads_retrieval', 'whatsapp_business_management'];

describe('Ads connection (007 US1)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let config: AppConfig;
  let redis: Redis;
  const TOKEN = `EAAGadsok${digits(24)}`;
  const TOKEN_NO_LEADS = `EAAGadsnoleads${digits(20)}`;
  const PAGE_TOKEN = `EAAGpage${digits(24)}`;
  const graph = { tokenValid: true };

  const post = (who: SignedInAgent, url: string, body?: object) => who.agent.post(`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const byName = (checks: Array<{ check: string }>) => Object.fromEntries(checks.map((c) => [c.check, c])) as Record<string, Json>;

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
        if (input === TOKEN && graph.tokenValid) return [200, { data: { app_id: config.META_APP_ID, type: 'SYSTEM_USER', is_valid: true, expires_at: 0, scopes: ALL } }];
        if (input === TOKEN_NO_LEADS) return [200, { data: { app_id: config.META_APP_ID, type: 'SYSTEM_USER', is_valid: true, expires_at: 0, scopes: ALL.filter((s) => s !== 'leads_retrieval') } }];
        return [200, { data: { is_valid: false, scopes: [], error: { code: 190, message: 'Session has expired' } } }];
      });
    nock(META_BASE)
      .persist()
      .get(`${v}/me/adaccounts`)
      .query(true)
      .reply(200, {
        data: [
          { id: 'act_111', account_id: '111', name: 'Acme ads', account_status: 1, disable_reason: 0, currency: 'AED', timezone_name: 'Asia/Dubai', funding_source_details: { id: 'fs1', type: 1 } },
          { id: 'act_222', account_id: '222', name: 'Old ads', account_status: 2, disable_reason: 3, currency: 'USD', timezone_name: 'UTC' },
        ],
      });
    nock(META_BASE)
      .persist()
      .get(`${v}/act_111`)
      .query(true)
      .reply(200, { account_id: '111', name: 'Acme ads', account_status: 1, disable_reason: 0, currency: 'AED', timezone_name: 'Asia/Dubai', funding_source_details: { id: 'fs1' }, tos_accepted: { custom_audience_tos: 1 } });
    nock(META_BASE)
      .persist()
      .get(`${v}/act_222`)
      .query(true)
      .reply(200, { account_id: '222', name: 'Old ads', account_status: 2, disable_reason: 3, currency: 'USD', timezone_name: 'UTC' });
    nock(META_BASE)
      .persist()
      .get(`${v}/me/accounts`)
      .query(true)
      .reply(200, {
        data: [
          { id: 'P1', name: 'Acme', tasks: ['ADVERTISE', 'ANALYZE'], access_token: PAGE_TOKEN },
          { id: 'P2', name: 'Acme old page', tasks: ['ANALYZE'], access_token: `${PAGE_TOKEN}x` },
        ],
      });
    nock(META_BASE).persist().get(`${v}/P1`).query(true).reply(200, { id: 'P1', leadgen_tos_accepted: true, whatsapp_number: '+1 555 010 0001' });
    nock(META_BASE).persist().get(`${v}/P2`).query(true).reply(200, { id: 'P2', leadgen_tos_accepted: false });
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await clearAds(ctx);
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    config = ctx.app.get<AppConfig>(APP_CONFIG);
    redis = ctx.app.get<Redis>(REDIS_CLIENT);
    fakeGraph();
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearAds(ctx);
    await ctx.close();
  });

  it('starts a session from a token, listing the ad accounts and pages it reaches; the token is kept encrypted', async () => {
    const res = await post(admin, '/ads/connection/token', { accessToken: TOKEN });
    expect(res.status).toBe(201);
    expect(res.body.adAccounts).toEqual([
      { id: '111', name: 'Acme ads', currency: 'AED', timezone: 'Asia/Dubai', active: true },
      { id: '222', name: 'Old ads', currency: 'USD', timezone: 'UTC', active: false },
    ]);
    expect(res.body.pages).toEqual([
      { id: 'P1', name: 'Acme' },
      { id: 'P2', name: 'Acme old page' },
    ]);
    expect(res.body.token.result).toBe('PASSED');
    expect(JSON.stringify(res.body)).not.toContain(TOKEN);
    expect(JSON.stringify(res.body)).not.toContain(PAGE_TOKEN);
    const stored = await redis.get(`wbm:ads-session:${res.body.id}`);
    expect(stored).toBeTruthy();
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(PAGE_TOKEN);
    expect(await redis.ttl(`wbm:ads-session:${res.body.id}`)).toBeGreaterThan(29 * 60);
  });

  it('names a missing permission with what stops working, and refuses an invalid token', async () => {
    const noLeads = await post(admin, '/ads/connection/token', { accessToken: TOKEN_NO_LEADS });
    expect(noLeads.status).toBe(201);
    expect(noLeads.body.token).toMatchObject({ check: 'TOKEN_PERMISSIONS', result: 'WARNING', detail: 'The token is missing leads_retrieval (for receiving leads).' });
    const bad = await post(admin, '/ads/connection/token', { accessToken: `EAAGbad${digits(20)}` });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('TOKEN_INVALID');
  });

  it('checks a disabled account without a payment method, and a page without ads access or linked numbers', async () => {
    const session = (await post(admin, '/ads/connection/token', { accessToken: TOKEN })).body as { id: string };
    const res = await post(admin, '/ads/connection/checks', { sessionId: session.id, adAccountId: '222', pageId: 'P2' });
    expect(res.status).toBe(200);
    expect(res.body.ready).toBe(false);
    const checks = byName(res.body.checks);
    expect(checks.AD_ACCOUNT_ACTIVE).toMatchObject({ result: 'FAILED', detail: 'The ad account is disabled (payment risk).' });
    expect(checks.AD_ACCOUNT_PAYMENT!.result).toBe('FAILED');
    expect(checks.PAGE_ADS!.result).toBe('FAILED');
    expect(checks.PAGE_WHATSAPP_NUMBERS!.result).toBe('WARNING');
    expect(checks.PAGE_WHATSAPP_NUMBERS!.fix).toEqual(expect.any(String));
    expect(checks.LEAD_TERMS!.result).toBe('WARNING');
    const refused = await post(admin, '/ads/connection', { sessionId: session.id, adAccountId: '222', pageId: 'P2' });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('CHECKS_FAILED');
  });

  it('saves one connection with the tokens encrypted and never returned, then runs the checks again', async () => {
    const number = await seedNumber(ctx);
    const session = (await post(admin, '/ads/connection/token', { accessToken: TOKEN })).body as { id: string };
    const ok = await post(admin, '/ads/connection/checks', { sessionId: session.id, adAccountId: '111', pageId: 'P1' });
    expect(ok.body.ready).toBe(true);
    expect(byName(ok.body.checks).AD_ACCOUNT_CURRENCY).toMatchObject({ result: 'PASSED', detail: 'Amounts are in AED; days follow Asia/Dubai.' });

    const saved = await post(admin, '/ads/connection', { sessionId: session.id, adAccountId: '111', pageId: 'P1' });
    expect(saved.status).toBe(201);
    expect(saved.body).toMatchObject({
      adAccountId: '111',
      adAccountName: 'Acme ads',
      pageId: 'P1',
      pageName: 'Acme',
      currency: 'AED',
      timezone: 'Asia/Dubai',
      status: 'CONNECTED',
      monthlyCapMinor: null,
      monthSpendMinor: 0,
    });
    expect(saved.body.checks.ready).toBe(true);
    expect(saved.body.linkedNumberIds).toContain(number.id);
    expect(JSON.stringify(saved.body)).not.toContain(TOKEN);
    expect(JSON.stringify(saved.body)).not.toContain(PAGE_TOKEN);

    const rows = await ctx.prisma.adsConnection.findMany();
    expect(rows).toHaveLength(1);
    const cipher = ctx.app.get(TokenCipher);
    expect(rows[0]!.tokenEnc).not.toContain(TOKEN);
    expect(cipher.decrypt(rows[0]!.tokenEnc)).toBe(TOKEN);
    expect(cipher.decrypt(rows[0]!.pageTokenEnc!)).toBe(PAGE_TOKEN);
    expect(await redis.get(`wbm:ads-session:${session.id}`)).toBeNull();

    const read = await agent.agent.get('/api/ads/connection');
    expect(read.status).toBe(200);
    expect(read.body.connection).toMatchObject({ adAccountId: '111', currency: 'AED', status: 'CONNECTED' });
    expect(JSON.stringify(read.body)).not.toContain(TOKEN);

    const again = await post(admin, '/ads/connection/checks', {});
    expect(again.status).toBe(200);
    expect(again.body.ready).toBe(true);
  });

  it('sets ERROR and alerts admins when the stored token stops working, and recovers on a passing run', async () => {
    graph.tokenValid = false;
    const failed = await post(admin, '/ads/connection/checks', {});
    expect(failed.status).toBe(200);
    expect(failed.body.ready).toBe(false);
    expect(byName(failed.body.checks).TOKEN_VALID!.result).toBe('FAILED');
    expect((await ctx.prisma.adsConnection.findFirstOrThrow()).status).toBe('ERROR');
    const alerts = await ctx.prisma.notification.findMany({ where: { type: 'ADS_CONNECTION_ERROR', userId: admin.userId } });
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect((await agent.agent.get('/api/ads/connection')).body.connection.status).toBe('ERROR');

    graph.tokenValid = true;
    const fixed = await post(admin, '/ads/connection/checks', {});
    expect(fixed.body.ready).toBe(true);
    expect((await ctx.prisma.adsConnection.findFirstOrThrow()).status).toBe('CONNECTED');
  });

  it('sets and clears the monthly spending cap', async () => {
    const set = await admin.agent.put('/api/ads/connection/spend-cap').set('X-CSRF-Token', admin.csrf).send({ monthlyCapMinor: 500_000 });
    expect(set.status).toBe(200);
    expect(set.body.monthlyCapMinor).toBe(500_000);
    const cleared = await admin.agent.put('/api/ads/connection/spend-cap').set('X-CSRF-Token', admin.csrf).send({ monthlyCapMinor: null });
    expect(cleared.body.monthlyCapMinor).toBeNull();
    const invalid = await admin.agent.put('/api/ads/connection/spend-cap').set('X-CSRF-Token', admin.csrf).send({ monthlyCapMinor: 0 });
    expect(invalid.status).toBe(422);
  });

  it('keeps the connection to admins; managers and agents can only read it', async () => {
    expect((await post(manager, '/ads/connection/token', { accessToken: TOKEN })).status).toBe(403);
    expect((await post(manager, '/ads/connection/checks', {})).status).toBe(403);
    expect((await manager.agent.put('/api/ads/connection/spend-cap').set('X-CSRF-Token', manager.csrf).send({ monthlyCapMinor: 1 })).status).toBe(403);
    expect((await agent.agent.delete('/api/ads/connection').set('X-CSRF-Token', agent.csrf)).status).toBe(403);
    expect((await manager.agent.get('/api/ads/connection')).status).toBe(200);
  });

  it('gives 404 for an expired or unknown session, and for another admin’s session', async () => {
    const unknown = await post(admin, '/ads/connection/checks', { sessionId: '0190a0b0-0000-7000-8000-000000000000', adAccountId: '111', pageId: 'P1' });
    expect(unknown.status).toBe(404);
    const session = (await post(admin, '/ads/connection/token', { accessToken: TOKEN })).body as { id: string };
    const other = await signIn(ctx, 'ADMIN');
    expect((await post(other, '/ads/connection', { sessionId: session.id, adAccountId: '111', pageId: 'P1' })).status).toBe(404);
  });

  it('disconnects, and records audit entries without tokens', async () => {
    const res = await admin.agent.delete('/api/ads/connection').set('X-CSRF-Token', admin.csrf);
    expect(res.status).toBe(204);
    expect((await agent.agent.get('/api/ads/connection')).body).toEqual({ connection: null });
    expect((await admin.agent.delete('/api/ads/connection').set('X-CSRF-Token', admin.csrf)).status).toBe(404);
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: { startsWith: 'ads.' }, actorUserId: admin.userId } });
    expect(new Set(audits.map((a) => a.action))).toEqual(new Set(['ads.connected', 'ads.checks_run', 'ads.spend_cap_changed', 'ads.disconnected']));
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
    expect(JSON.stringify(audits)).not.toContain(PAGE_TOKEN);
  });
});
