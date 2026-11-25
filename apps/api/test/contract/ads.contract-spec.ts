import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../../src/common/config/config.module.js';
import type { AppConfig } from '../../src/common/config/config.js';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { clearAds, seedAdsConnection } from '../support/ads.js';
import { FakeAdsGraph } from '../support/fake-ads-graph.js';
import { META_BASE, META_VERSION, digits, restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 007 contract tests (T020 and later stories): responses match contracts/ads-api.openapi.yaml.
const ALL = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement', 'pages_manage_ads', 'pages_manage_metadata', 'leads_retrieval', 'whatsapp_business_management'];

describe('Ads API contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let config: AppConfig;
  const TOKEN = `EAAGcontract${digits(24)}`;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('ads-api.openapi.yaml', method, route, res.status, res.body);
  };
  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = admin.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', admin.csrf).send(body ?? {});
  };

  function fakeConnectionGraph(): void {
    const v = `/${META_VERSION}`;
    nock(META_BASE)
      .persist()
      .get(`${v}/debug_token`)
      .query(true)
      .reply(async (request: Request) => {
        const input = new URL(request.url).searchParams.get('input_token');
        return input === TOKEN
          ? [200, { data: { app_id: config.META_APP_ID, type: 'SYSTEM_USER', is_valid: true, expires_at: 0, scopes: ALL } }]
          : [200, { data: { is_valid: false, scopes: [], error: { code: 190, message: 'Invalid OAuth access token.' } } }];
      });
    nock(META_BASE)
      .persist()
      .get(`${v}/me/adaccounts`)
      .query(true)
      .reply(200, { data: [{ id: 'act_111', account_id: '111', name: 'Acme ads', account_status: 1, currency: 'AED', timezone_name: 'Asia/Dubai', funding_source_details: { id: 'fs1' } }] });
    nock(META_BASE)
      .persist()
      .get(`${v}/act_111`)
      .query(true)
      .reply(200, { account_id: '111', name: 'Acme ads', account_status: 1, currency: 'AED', timezone_name: 'Asia/Dubai', funding_source_details: { id: 'fs1' }, tos_accepted: { custom_audience_tos: 1 } });
    nock(META_BASE)
      .persist()
      .get(`${v}/me/accounts`)
      .query(true)
      .reply(200, { data: [{ id: 'P1', name: 'Acme', tasks: ['ADVERTISE'], access_token: `EAAGpage${digits(20)}` }] });
    nock(META_BASE).persist().get(`${v}/P1`).query(true).reply(200, { id: 'P1', leadgen_tos_accepted: true, whatsapp_number: '+1 555 010 0001' });
  }

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await clearAds(ctx);
    admin = await signIn(ctx, 'ADMIN');
    config = ctx.app.get<AppConfig>(APP_CONFIG);
    fakeConnectionGraph();
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearAds(ctx);
    await ctx.close();
  });

  it('US1: the token session, checks, saving, the cap and disconnecting', async () => {
    await check('get', '/ads/connection', await call('get', '/ads/connection'), 200);
    await check('post', '/ads/connection/token', await call('post', '/ads/connection/token', { accessToken: `EAAGbad${digits(20)}` }), 422);
    const session = await call('post', '/ads/connection/token', { accessToken: TOKEN });
    await check('post', '/ads/connection/token', session, 201);
    const sessionId = session.body.id as string;
    await check('post', '/ads/connection/checks', await call('post', '/ads/connection/checks', { sessionId, adAccountId: '111', pageId: 'P1' }), 200);
    await check('post', '/ads/connection/checks', await call('post', '/ads/connection/checks', { sessionId: randomUUID(), adAccountId: '111', pageId: 'P1' }), 404);
    await check('post', '/ads/connection', await call('post', '/ads/connection', { sessionId: randomUUID(), adAccountId: '111', pageId: 'P1' }), 404);
    await check('post', '/ads/connection', await call('post', '/ads/connection', { sessionId, adAccountId: '111', pageId: 'P1' }), 201);
    await check('get', '/ads/connection', await call('get', '/ads/connection'), 200);
    await check('post', '/ads/connection/checks', await call('post', '/ads/connection/checks', {}), 200);
    await check('put', '/ads/connection/spend-cap', await call('put', '/ads/connection/spend-cap', { monthlyCapMinor: 100_000 }), 200);
    await check('put', '/ads/connection/spend-cap', await call('put', '/ads/connection/spend-cap', { monthlyCapMinor: null }), 200);
    await check('delete', '/ads/connection', await call('delete', '/ads/connection'), 204);
    await check('delete', '/ads/connection', await call('delete', '/ads/connection'), 404);
    await check('put', '/ads/connection/spend-cap', await call('put', '/ads/connection/spend-cap', { monthlyCapMinor: 1 }), 404);
  });

  it('US2 and US3: campaigns, targeting, versions, submit and chats from ads', async () => {
    new FakeAdsGraph().install();
    await seedAdsConnection(ctx);
    const number = await seedNumber(ctx);
    const key = `library/contract-${randomUUID()}.jpg`;
    await ctx.app.get(StorageService).put(key, Buffer.from('jpeg-bytes'), 'image/jpeg');
    const media = await ctx.prisma.mediaAsset.create({ data: { storageKey: key, mimeType: 'image/jpeg', sizeBytes: 100_000, purpose: 'LIBRARY' } });
    const targeting = { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country', countryCode: 'AE' }], ageMin: 25, ageMax: 45 };
    const version = { mediaAssetId: media.id, primaryText: 'Spring sale', headline: 'Chat with us', callToAction: 'WHATSAPP_MESSAGE' };
    const input = { name: uniq('Contract ad '), goal: 'CHATS', numberId: number.id, prefilledMessage: 'Hi', targeting, placements: { auto: true }, dailyBudgetMinor: 5_000, startAt: new Date().toISOString(), versions: [version] };
    const missing = randomUUID();

    await check('get', '/ads/targeting/locations', await call('get', '/ads/targeting/locations?q=Dub'), 200);
    await check('get', '/ads/targeting/interests', await call('get', '/ads/targeting/interests?q=sho'), 200);
    await check('post', '/ads/targeting/estimate', await call('post', '/ads/targeting/estimate', { goal: 'CHATS', targeting, placements: { auto: true } }), 200);
    await check('post', '/ads/targeting/estimate', await call('post', '/ads/targeting/estimate', { goal: 'CHATS', targeting: { ...targeting, ageMin: 50, ageMax: 30 } }), 422);

    const created = await call('post', '/ads/campaigns', input);
    await check('post', '/ads/campaigns', created, 201);
    await check('post', '/ads/campaigns', await call('post', '/ads/campaigns', input), 409);
    await check('post', '/ads/campaigns', await call('post', '/ads/campaigns', { ...input, name: uniq('Bad '), numberId: null }), 422);
    const id = created.body.id as string;
    await check('get', '/ads/campaigns', await call('get', '/ads/campaigns'), 200);
    await check('get', '/ads/campaigns/{id}', await call('get', `/ads/campaigns/${id}`), 200);
    await check('get', '/ads/campaigns/{id}', await call('get', `/ads/campaigns/${missing}`), 404);
    await check('patch', '/ads/campaigns/{id}', await call('patch', `/ads/campaigns/${id}`, { dailyBudgetMinor: 6_000 }), 200);
    await check('patch', '/ads/campaigns/{id}', await call('patch', `/ads/campaigns/${missing}`, { dailyBudgetMinor: 6_000 }), 404);
    const versionId = created.body.versions[0].id as string;
    await check('put', '/ads/campaigns/{id}/versions/{versionId}', await call('put', `/ads/campaigns/${id}/versions/${versionId}`, { ...version, headline: 'Talk to us' }), 200);
    await check('put', '/ads/campaigns/{id}/versions/{versionId}', await call('put', `/ads/campaigns/${id}/versions/${missing}`, version), 404);

    await check('post', '/ads/campaigns/{id}/submit', await call('post', `/ads/campaigns/${id}/submit`), 200);
    await check('post', '/ads/campaigns/{id}/submit', await call('post', `/ads/campaigns/${id}/submit`), 409);
    await check('post', '/ads/campaigns/{id}/submit', await call('post', `/ads/campaigns/${missing}/submit`), 404);
    await check('patch', '/ads/campaigns/{id}', await call('patch', `/ads/campaigns/${id}`, { name: 'Renamed' }), 409);
    await check('put', '/ads/campaigns/{id}/versions/{versionId}', await call('put', `/ads/campaigns/${id}/versions/${versionId}`, version), 409);
    await check('delete', '/ads/campaigns/{id}', await call('delete', `/ads/campaigns/${id}`), 409);
    const draft = await call('post', '/ads/campaigns', { ...input, name: uniq('Draft ad ') });
    await check('delete', '/ads/campaigns/{id}', await call('delete', `/ads/campaigns/${draft.body.id}`), 204);
    await check('delete', '/ads/campaigns/{id}', await call('delete', `/ads/campaigns/${missing}`), 404);

    await check('get', '/ads/campaigns/{id}/chats', await call('get', `/ads/campaigns/${id}/chats`), 200);
    await check('get', '/ads/campaigns/{id}/chats', await call('get', `/ads/campaigns/${missing}/chats`), 404);
    await check('get', '/ads/other-chats', await call('get', '/ads/other-chats'), 200);
  });
});
