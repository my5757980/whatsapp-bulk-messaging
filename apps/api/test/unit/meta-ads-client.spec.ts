import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/common/config/config.js';
import { MetaAdsClient, feedbackText } from '../../src/modules/ads/meta-ads.client.js';
import { MetaApiError } from '../../src/modules/meta/meta-graph.client.js';

// T013 (feature 007, contracts/meta-ads-graph.md): the ads Graph calls, mapped and with errors.
const BASE = 'https://graph.facebook.test';
const V = '/v27.0';
const config = { META_GRAPH_BASE_URL: BASE, META_GRAPH_API_VERSION: 'v27.0' } as AppConfig;
const client = new MetaAdsClient(config, { timeoutMs: 500 });

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('MetaAdsClient: connection', () => {
  it('reads ad accounts, pages and the page facts', async () => {
    nock(BASE)
      .get(`${V}/me/adaccounts`)
      .query(true)
      .matchHeader('authorization', 'Bearer tok')
      .reply(200, {
        data: [
          { id: 'act_111', account_id: '111', name: 'Acme ads', account_status: 1, disable_reason: 0, currency: 'AED', timezone_name: 'Asia/Dubai', funding_source_details: { id: 'fs1', type: 1 } },
          { id: 'act_222', account_id: '222', name: 'Old', account_status: 2, disable_reason: 3, currency: 'USD', timezone_name: 'UTC' },
        ],
      });
    expect(await client.adAccounts('tok')).toEqual([
      { id: '111', name: 'Acme ads', accountStatus: 1, disableReason: null, currency: 'AED', timezone: 'Asia/Dubai', hasPaymentMethod: true, audienceTermsAccepted: null },
      { id: '222', name: 'Old', accountStatus: 2, disableReason: 3, currency: 'USD', timezone: 'UTC', hasPaymentMethod: false, audienceTermsAccepted: null },
    ]);
    nock(BASE).get(`${V}/act_111`).query(true).reply(200, { account_id: '111', name: 'Acme ads', account_status: 1, currency: 'AED', timezone_name: 'Asia/Dubai', tos_accepted: { custom_audience_tos: 1 } });
    expect((await client.adAccount('tok', '111')).audienceTermsAccepted).toBe(true);
    nock(BASE)
      .get(`${V}/me/accounts`)
      .query(true)
      .reply(200, { data: [{ id: 'P1', name: 'Acme', tasks: ['ADVERTISE'], access_token: 'page-token' }] });
    expect(await client.pages('tok')).toEqual([{ id: 'P1', name: 'Acme', tasks: ['ADVERTISE'], accessToken: 'page-token' }]);
  });

  it('reads the linked number when Meta allows it, and falls back when the field is refused', async () => {
    nock(BASE)
      .get(`${V}/P1`)
      .query({ fields: 'leadgen_tos_accepted,whatsapp_number' })
      .reply(200, { leadgen_tos_accepted: true, whatsapp_number: '+971501234567' });
    expect(await client.pageAdsFacts('tok', 'P1')).toEqual({ leadTermsAccepted: true, whatsappNumbers: ['+971501234567'] });
    nock(BASE)
      .get(`${V}/P1`)
      .query({ fields: 'leadgen_tos_accepted,whatsapp_number' })
      .reply(400, { error: { message: '(#100) Tried accessing nonexisting field (whatsapp_number)', code: 100 } });
    nock(BASE).get(`${V}/P1`).query({ fields: 'leadgen_tos_accepted' }).reply(200, { leadgen_tos_accepted: false });
    expect(await client.pageAdsFacts('tok', 'P1')).toEqual({ leadTermsAccepted: false, whatsappNumbers: null });
  });
});

describe('MetaAdsClient: building', () => {
  it('searches places and interests, estimates audiences and reads the minimum budget', async () => {
    nock(BASE)
      .get(`${V}/search`)
      .query((q) => q.type === 'adgeolocation' && q.q === 'Dub')
      .reply(200, { data: [{ key: '3005', name: 'Dubai', type: 'region', country_code: 'AE' }] });
    expect(await client.searchLocations('tok', 'Dub')).toEqual([{ key: '3005', name: 'Dubai', type: 'region', countryCode: 'AE', audienceLower: null, audienceUpper: null }]);
    nock(BASE)
      .get(`${V}/search`)
      .query((q) => q.type === 'adinterest')
      .reply(200, { data: [{ id: 6003, name: 'Shoes', audience_size_lower_bound: 1000, audience_size_upper_bound: 2000 }] });
    expect(await client.searchInterests('tok', 'shoe')).toEqual([{ key: '6003', name: 'Shoes', type: 'interest', countryCode: null, audienceLower: 1000, audienceUpper: 2000 }]);
    nock(BASE)
      .get(`${V}/act_111/delivery_estimate`)
      .query((q) => q.optimization_goal === 'CONVERSATIONS' && JSON.parse(String(q.targeting_spec)).age_min === 25)
      .reply(200, { data: [{ estimate_mau_lower_bound: 120000, estimate_mau_upper_bound: 150000 }] });
    expect(await client.deliveryEstimate('tok', '111', { age_min: 25 }, 'CONVERSATIONS')).toEqual({ lower: 120000, upper: 150000 });
    nock(BASE).get(`${V}/act_111/delivery_estimate`).query(true).reply(200, { data: [{ estimate_mau_lower_bound: -1, estimate_mau_upper_bound: -1 }] });
    expect(await client.deliveryEstimate('tok', '111', {}, 'CONVERSATIONS')).toEqual({ lower: null, upper: null });
    nock(BASE).get(`${V}/act_111/minimum_budgets`).reply(200, { data: [{ currency: 'AED', min_daily_budget_imp: 400, min_daily_budget_high_freq: 1000 }] });
    expect(await client.minimumDailyBudget('tok', '111')).toEqual({ currency: 'AED', minDailyBudgetMinor: 400 });
  });

  it('uploads media, makes the welcome sequence and the ad objects, and deletes on rollback', async () => {
    nock(BASE).post(`${V}/act_111/adimages`).reply(200, { images: { 'ad.jpg': { hash: 'abc123', url: 'https://x' } } });
    expect(await client.uploadImage('tok', '111', Buffer.from('jpg'), 'ad.jpg', 'image/jpeg')).toBe('abc123');
    nock(BASE).post(`${V}/act_111/advideos`).reply(200, { id: 'V1' });
    expect(await client.uploadVideo('tok', '111', Buffer.from('mp4'), 'ad.mp4', 'video/mp4')).toBe('V1');
    nock(BASE).get(`${V}/V1`).query(true).reply(200, { status: { video_status: 'ready' } });
    expect(await client.videoStatus('tok', 'V1')).toBe('ready');
    nock(BASE)
      .post(`${V}/WABA1/welcome_message_sequences`, (b: { name: string; welcome_message_sequence: string }) => JSON.parse(b.welcome_message_sequence).autofill_message.content === 'Hi there')
      .reply(200, { sequence_id: 'SEQ1' });
    expect(await client.createWelcomeSequence('tok', 'WABA1', 'Spring', 'Hi there')).toBe('SEQ1');
    nock(BASE)
      .post(`${V}/act_111/campaigns`, (b: Record<string, unknown>) => b.objective === 'OUTCOME_ENGAGEMENT')
      .reply(200, { id: 'C1' });
    expect(await client.create('tok', '111', 'campaigns', { objective: 'OUTCOME_ENGAGEMENT' })).toBe('C1');
    nock(BASE).post(`${V}/C1`, { status: 'PAUSED' }).reply(200, { success: true });
    await client.update('tok', 'C1', { status: 'PAUSED' });
    nock(BASE).delete(`${V}/C1`).reply(200, { success: true });
    await client.deleteObject('tok', 'C1');
    nock(BASE).post(`${V}/act_111/adsets`).reply(400, { error: { message: 'Invalid parameter', error_user_msg: 'The daily budget is too low.', code: 100, error_subcode: 1885272 } });
    const error = await client.create('tok', '111', 'adsets', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect((error as MetaApiError).message).toBe('The daily budget is too low.');
  });
});

describe('MetaAdsClient: running, audiences and leads', () => {
  it('reads states with review feedback, and insights with paging and actions', async () => {
    nock(BASE).get(`${V}/C1`).query(true).reply(200, { effective_status: 'ACTIVE', configured_status: 'ACTIVE' });
    expect(await client.objectStatus('tok', 'C1')).toEqual({ effectiveStatus: 'ACTIVE', configuredStatus: 'ACTIVE' });
    nock(BASE)
      .get(`${V}/S1/ads`)
      .query(true)
      .reply(200, { data: [{ id: 'A1', effective_status: 'DISAPPROVED', ad_review_feedback: { global: { POLICY: 'Ads may not promise results.' } } }, { id: 'A2', effective_status: 'ACTIVE' }] });
    expect(await client.adsOf('tok', 'S1')).toEqual([
      { id: 'A1', effectiveStatus: 'DISAPPROVED', feedback: 'Ads may not promise results.' },
      { id: 'A2', effectiveStatus: 'ACTIVE', feedback: null },
    ]);
    nock(BASE)
      .get(`${V}/C1/insights`)
      .query((q) => q.level === 'ad' && q.time_increment === '1')
      .reply(200, {
        data: [
          {
            ad_id: 'A2',
            date_start: '2026-11-24',
            impressions: '1000',
            reach: '800',
            clicks: '25',
            spend: '12.34',
            actions: [
              { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: '3' },
              { action_type: 'link_click', value: '25' },
            ],
          },
        ],
        paging: { next: `${BASE}${V}/C1/insights?after=X` },
      });
    nock(BASE)
      .get(`${V}/C1/insights`)
      .query({ after: 'X' })
      .reply(200, { data: [{ ad_id: 'A2', date_start: '2026-11-25', impressions: '10', reach: '9', clicks: '1', spend: '0.5', actions: [{ action_type: 'lead', value: '2' }] }] });
    expect(await client.insights('tok', 'C1', { since: '2026-11-24', until: '2026-11-25' }, 'AED', 'ad')).toEqual([
      { adId: 'A2', date: '2026-11-24', impressions: 1000, reach: 800, clicks: 25, spendMinor: 1234, conversations: 3, leads: 0 },
      { adId: 'A2', date: '2026-11-25', impressions: 10, reach: 9, clicks: 1, spendMinor: 50, conversations: 0, leads: 2 },
    ]);
  });

  it('adds and removes hashed phones, makes lookalikes, and reads leads with their consent', async () => {
    nock(BASE)
      .post(`${V}/act_111/customaudiences`, (b: Record<string, unknown>) => b.subtype === 'CUSTOM' && b.customer_file_source === 'USER_PROVIDED_ONLY')
      .reply(200, { id: 'AUD1' });
    expect(await client.createCustomAudience('tok', '111', 'VIP')).toBe('AUD1');
    nock(BASE).post(`${V}/AUD1/users`, { payload: { schema: 'PHONE_SHA256', data: ['h1', 'h2'] } }).reply(200, { num_received: 2 });
    await client.addAudienceUsers('tok', 'AUD1', ['h1', 'h2']);
    nock(BASE).delete(`${V}/AUD1/users`, { payload: { schema: 'PHONE_SHA256', data: ['h1'] } }).reply(200, { num_received: 1 });
    await client.removeAudienceUsers('tok', 'AUD1', ['h1']);
    nock(BASE)
      .post(`${V}/act_111/customaudiences`, (b: Record<string, unknown>) => b.subtype === 'LOOKALIKE' && JSON.parse(String(b.lookalike_spec)).ratio === 0.01)
      .reply(200, { id: 'LAL1' });
    expect(await client.createLookalike('tok', '111', { name: 'VIP 1%', originAudienceId: 'AUD1', country: 'AE', ratio: 0.01 })).toBe('LAL1');
    nock(BASE)
      .get(`${V}/L1`)
      .query(true)
      .reply(200, {
        id: 'L1',
        created_time: '2026-11-25T08:00:00+0000',
        ad_id: 'A3',
        form_id: 'F1',
        field_data: [
          { name: 'full_name', values: ['Sara'] },
          { name: 'phone_number', values: ['+971501234567'] },
        ],
        custom_disclaimer_responses: [{ checkbox_key: 'whatsapp_consent', is_checked: '1' }],
      });
    expect(await client.lead('tok', 'L1')).toEqual({
      id: 'L1',
      createdTime: '2026-11-25T08:00:00+0000',
      adId: 'A3',
      formId: 'F1',
      fields: { full_name: 'Sara', phone_number: '+971501234567' },
      disclaimers: { whatsapp_consent: true },
    });
  });

  it('slows down when Meta reports high usage, and flattens feedback', async () => {
    nock(BASE)
      .get(`${V}/C2`)
      .query(true)
      .reply(200, { effective_status: 'ACTIVE' }, { 'x-business-use-case-usage': JSON.stringify({ '111': [{ type: 'ads_management', call_count: 80, total_cputime: 10, total_time: 10 }] }) });
    await client.objectStatus('tok', 'C2');
    expect(client.busy()).toBe(true);
    nock(BASE)
      .get(`${V}/C2`)
      .query(true)
      .reply(200, { effective_status: 'ACTIVE' }, { 'x-business-use-case-usage': JSON.stringify({ '111': [{ call_count: 5 }] }) });
    await client.objectStatus('tok', 'C2');
    expect(client.busy()).toBe(false);
    expect(feedbackText('Plain reason')).toBe('Plain reason');
    expect(feedbackText(null)).toBeNull();
  });
});
