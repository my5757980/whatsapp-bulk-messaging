// Feature 007 (T004, T026 and the later stories; contracts/meta-ads-graph.md "mock-meta behaviour"): the
// Marketing API routes, answered for the ads tokens and the mock page token only, so the routes for
// "mock-token" are unchanged.
//   mock-ads-token-ok        every permission, never expires
//   mock-ads-token-no-leads  no leads_retrieval
// Ad account act_MOCKADS (AED, Asia/Dubai, active, with a payment method), page MOCKPAGE linked to the
// mock number. New ads stay PENDING_REVIEW for 3 seconds, then ACTIVE; a version whose text holds
// "reject-me" becomes DISAPPROVED with a reason. Insights grow each time they are read while active.
// POST /mock/ads/lead sends a signed page leadgen webhook for a form with given answers.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { postSigned } from './webhook-emitter.js';

export const ADS_TOKENS = { ok: 'mock-ads-token-ok', noLeads: 'mock-ads-token-no-leads' } as const;
export const ADS_ACCOUNT = 'MOCKADS';
export const ADS_PAGE = 'MOCKPAGE';
export const ADS_PAGE_TOKEN = 'mock-ads-page-token-0001';
const APP_ID = process.env.META_APP_ID || '1234567890';
const LINKED_NUMBER = process.env.MOCK_ADS_LINKED_NUMBER ?? '+1 555 010 0000';
const REVIEW_MS = Number(process.env.MOCK_ADS_REVIEW_MS ?? 3000);
const ALL_SCOPES = [
  'ads_management',
  'ads_read',
  'business_management',
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_ads',
  'pages_manage_metadata',
  'leads_retrieval',
  'whatsapp_business_management',
];

const LOCATIONS = [
  { key: 'AE', name: 'United Arab Emirates', type: 'country', country_code: 'AE' },
  { key: '3005', name: 'Dubai', type: 'region', country_code: 'AE' },
  { key: '3006', name: 'Abu Dhabi', type: 'region', country_code: 'AE' },
  { key: '1035211', name: 'Sharjah', type: 'city', country_code: 'AE' },
  { key: 'SA', name: 'Saudi Arabia', type: 'country', country_code: 'SA' },
  { key: 'PK', name: 'Pakistan', type: 'country', country_code: 'PK' },
  { key: 'IN', name: 'India', type: 'country', country_code: 'IN' },
];
const INTERESTS = [
  { id: '6003348604581', name: 'Shoes', audience_size_lower_bound: 1_200_000, audience_size_upper_bound: 1_400_000 },
  { id: '6003255640088', name: 'Fashion', audience_size_lower_bound: 9_000_000, audience_size_upper_bound: 10_500_000 },
  { id: '6003346592981', name: 'Online shopping', audience_size_lower_bound: 5_000_000, audience_size_upper_bound: 6_000_000 },
  { id: '6003578086487', name: 'Real estate', audience_size_lower_bound: 800_000, audience_size_upper_bound: 950_000 },
];

interface Campaign { id: string; status: string; name: string; objective: string }
interface AdSet { id: string; campaignId: string; status: string; dailyBudget: number; endTime: string | null }
interface Ad { id: string; adsetId: string; creativeId: string; status: string; reviewFrom: number; insights: { impressions: number; reach: number; clicks: number; spend: number; conversations: number; leads: number } }
interface Audience { id: string; subtype: string; members: Set<string> }
interface Lead { id: string; formId: string; adId: string | null; createdTime: string; answers: Record<string, string>; consent: boolean }

const creatives = new Map<string, string>();
const campaigns = new Map<string, Campaign>();
const adsets = new Map<string, AdSet>();
const ads = new Map<string, Ad>();
const videos = new Set<string>();
const audiences = new Map<string, Audience>();
const forms = new Set<string>();
const leads = new Map<string, Lead>();
let counter = 0;
const nextId = (kind: string) => `MOCK${kind}${Date.now()}${(counter++).toString().padStart(3, '0')}`;

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function graphError(res: ServerResponse, status: number, code: number, message: string): true {
  return send(res, status, { error: { message, error_user_msg: message, type: 'OAuthException', code, fbtrace_id: 'MOCKADS' } });
}

async function readText(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const text = await readText(req);
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
}

const adsToken = (token: string) => (Object.values(ADS_TOKENS) as string[]).includes(token);
const appToken = (token: string) => /^[0-9]+\|.+$/.test(token);

function debugData(input: string) {
  if (input === ADS_TOKENS.ok) return { app_id: APP_ID, type: 'SYSTEM_USER', application: 'Mock app', is_valid: true, expires_at: 0, scopes: ALL_SCOPES, granular_scopes: [] };
  if (input === ADS_TOKENS.noLeads) {
    return { app_id: APP_ID, type: 'SYSTEM_USER', application: 'Mock app', is_valid: true, expires_at: 0, scopes: ALL_SCOPES.filter((s) => s !== 'leads_retrieval'), granular_scopes: [] };
  }
  return null;
}

function account() {
  return {
    id: `act_${ADS_ACCOUNT}`,
    account_id: ADS_ACCOUNT,
    name: 'Mock ad account',
    account_status: 1,
    disable_reason: 0,
    currency: 'AED',
    timezone_name: 'Asia/Dubai',
    funding_source_details: { id: 'MOCKFUNDING', type: 1, display_string: 'Visa *1234' },
    tos_accepted: { custom_audience_tos: 1, web_custom_audience_tos: 1 },
  };
}

function adStatus(ad: Ad): { effective_status: string; ad_review_feedback?: Record<string, Record<string, string>> } {
  const adset = adsets.get(ad.adsetId);
  const campaign = adset ? campaigns.get(adset.campaignId) : undefined;
  if (ad.status === 'PAUSED') return { effective_status: 'PAUSED' };
  if (campaign?.status === 'PAUSED') return { effective_status: 'CAMPAIGN_PAUSED' };
  if (adset?.status === 'PAUSED') return { effective_status: 'ADSET_PAUSED' };
  if (Date.now() - ad.reviewFrom < REVIEW_MS) return { effective_status: 'PENDING_REVIEW' };
  if ((creatives.get(ad.creativeId) ?? '').includes('reject-me')) {
    return { effective_status: 'DISAPPROVED', ad_review_feedback: { global: { 'Unrealistic outcomes': 'Ads may not promise results that are unlikely to happen.' } } };
  }
  return { effective_status: 'ACTIVE' };
}

const todayInDubai = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dubai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

function insightActions(i: Ad['insights']) {
  return [
    { action_type: 'onsite_conversion.messaging_conversation_started_7d', value: String(i.conversations) },
    { action_type: 'link_click', value: String(i.clicks) },
    ...(i.leads ? [{ action_type: 'lead', value: String(i.leads) }] : []),
  ];
}

function insights(campaignId: string, level: string) {
  const day = todayInDubai();
  const own = [...ads.values()].filter((ad) => adsets.get(ad.adsetId)?.campaignId === campaignId);
  for (const ad of own) {
    if (adStatus(ad).effective_status !== 'ACTIVE') continue;
    ad.insights.impressions += 1000;
    ad.insights.reach += 800;
    ad.insights.clicks += 25;
    ad.insights.spend += 12.34;
    ad.insights.conversations += 3;
  }
  const row = (i: Ad['insights']) => ({
    impressions: String(i.impressions),
    reach: String(i.reach),
    clicks: String(i.clicks),
    spend: i.spend.toFixed(2),
    actions: insightActions(i),
    date_start: day,
    date_stop: day,
  });
  if (level === 'ad') return own.filter((ad) => ad.insights.impressions > 0).map((ad) => ({ ad_id: ad.id, ...row(ad.insights) }));
  const sum = own.reduce(
    (s, ad) => ({
      impressions: s.impressions + ad.insights.impressions,
      reach: s.reach + ad.insights.reach,
      clicks: s.clicks + ad.insights.clicks,
      spend: s.spend + ad.insights.spend,
      conversations: s.conversations + ad.insights.conversations,
      leads: s.leads + ad.insights.leads,
    }),
    { impressions: 0, reach: 0, clicks: 0, spend: 0, conversations: 0, leads: 0 },
  );
  return sum.impressions ? [row(sum)] : [];
}

function leadJson(lead: Lead) {
  return {
    id: lead.id,
    created_time: lead.createdTime,
    ad_id: lead.adId,
    form_id: lead.formId,
    field_data: Object.entries(lead.answers).map(([name, value]) => ({ name, values: [value] })),
    custom_disclaimer_responses: [{ checkbox_key: 'whatsapp_consent', is_checked: lead.consent ? '1' : '' }],
  };
}

/** POST /mock/ads/lead {formId, adId?, answers, consent}: stores a lead and sends the page leadgen webhook. */
async function mockLead(req: IncomingMessage, res: ServerResponse): Promise<true> {
  const body = (await readJson(req)) as { formId?: string; adId?: string; answers?: Record<string, string>; consent?: boolean };
  if (!body.formId) return send(res, 400, { error: 'formId is required' });
  const lead: Lead = {
    id: nextId('LEAD'),
    formId: body.formId,
    adId: body.adId ?? null,
    createdTime: new Date().toISOString().replace('Z', '+0000'),
    answers: body.answers ?? {},
    consent: body.consent === true,
  };
  leads.set(lead.id, lead);
  const status = await postSigned({
    object: 'page',
    entry: [
      {
        id: ADS_PAGE,
        time: Math.floor(Date.now() / 1000),
        changes: [{ field: 'leadgen', value: { leadgen_id: lead.id, form_id: lead.formId, ad_id: lead.adId, page_id: ADS_PAGE, created_time: Math.floor(Date.now() / 1000) } }],
      },
    ],
  });
  return send(res, 200, { leadId: lead.id, webhookStatus: status });
}

/** True when the request was an ads route and has been answered. */
export async function handleAds(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/mock/ads/lead') return mockLead(req, res);
  const [version, id, resource] = url.pathname.split('/').filter(Boolean);
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
  if (!version?.startsWith('v') || !id || !token) return false;

  if (req.method === 'GET' && id === 'debug_token') {
    const data = debugData(url.searchParams.get('input_token') ?? '');
    if (!data || !(adsToken(token) || appToken(token))) return false;
    return send(res, 200, { data });
  }
  const pageToken = token === ADS_PAGE_TOKEN;
  if (!adsToken(token) && !pageToken) return false;

  // Connection (R2)
  if (req.method === 'GET' && id === 'me' && resource === 'adaccounts') return send(res, 200, { data: [account()] });
  if (req.method === 'GET' && id === 'me' && resource === 'accounts') {
    return send(res, 200, { data: [{ id: ADS_PAGE, name: 'Mock Page', tasks: ['ADVERTISE', 'ANALYZE', 'CREATE_CONTENT', 'MANAGE', 'MODERATE'], access_token: ADS_PAGE_TOKEN }] });
  }
  if (req.method === 'GET' && id === `act_${ADS_ACCOUNT}` && !resource) return send(res, 200, account());
  if (req.method === 'GET' && id === ADS_PAGE && !resource) return send(res, 200, { id: ADS_PAGE, name: 'Mock Page', leadgen_tos_accepted: true, whatsapp_number: LINKED_NUMBER });

  // Building (R3–R5)
  if (req.method === 'GET' && id === 'search') {
    const q = (url.searchParams.get('q') ?? '').toLowerCase();
    if (url.searchParams.get('type') === 'adgeolocation') return send(res, 200, { data: LOCATIONS.filter((l) => l.name.toLowerCase().includes(q)) });
    if (url.searchParams.get('type') === 'adinterest') return send(res, 200, { data: INTERESTS.filter((i) => i.name.toLowerCase().includes(q)) });
    return graphError(res, 400, 100, 'Unsupported search type');
  }
  if (id === `act_${ADS_ACCOUNT}`) {
    if (req.method === 'GET' && resource === 'delivery_estimate') return send(res, 200, { data: [{ estimate_mau_lower_bound: 120_000, estimate_mau_upper_bound: 150_000, estimate_ready: true }] });
    if (req.method === 'GET' && resource === 'minimum_budgets') return send(res, 200, { data: [{ currency: 'AED', min_daily_budget_imp: 400, min_daily_budget_video_views: 400, min_daily_budget_high_freq: 2000, min_daily_budget_low_freq: 15000 }] });
    if (req.method === 'POST' && resource === 'adimages') {
      await readText(req);
      const hash = nextId('HASH').toLowerCase();
      return send(res, 200, { images: { 'upload.jpg': { hash, url: `https://mock.example/${hash}.jpg` } } });
    }
    if (req.method === 'POST' && resource === 'advideos') {
      await readText(req);
      const videoId = nextId('VID');
      videos.add(videoId);
      return send(res, 200, { id: videoId });
    }
    if (req.method === 'POST' && resource === 'adcreatives') {
      const body = await readJson(req);
      const creativeId = nextId('CR');
      creatives.set(creativeId, JSON.stringify(body));
      return send(res, 200, { id: creativeId });
    }
    if (req.method === 'POST' && resource === 'campaigns') {
      const body = await readJson(req);
      const campaign: Campaign = { id: nextId('CMP'), status: String(body.status ?? 'ACTIVE'), name: String(body.name ?? ''), objective: String(body.objective ?? '') };
      campaigns.set(campaign.id, campaign);
      return send(res, 200, { id: campaign.id });
    }
    if (req.method === 'POST' && resource === 'adsets') {
      const body = await readJson(req);
      if (!campaigns.has(String(body.campaign_id))) return graphError(res, 400, 100, 'The campaign does not exist');
      if (Number(body.daily_budget) < 400) return graphError(res, 400, 100, 'The daily budget is below the minimum of AED 4.00.');
      const adset: AdSet = { id: nextId('SET'), campaignId: String(body.campaign_id), status: String(body.status ?? 'ACTIVE'), dailyBudget: Number(body.daily_budget), endTime: (body.end_time as string) ?? null };
      adsets.set(adset.id, adset);
      return send(res, 200, { id: adset.id });
    }
    if (req.method === 'POST' && resource === 'ads') {
      const body = await readJson(req);
      const creative = body.creative as { creative_id?: string } | undefined;
      if (!adsets.has(String(body.adset_id)) || !creative?.creative_id || !creatives.has(creative.creative_id)) return graphError(res, 400, 100, 'The ad set or creative does not exist');
      const ad: Ad = {
        id: nextId('AD'),
        adsetId: String(body.adset_id),
        creativeId: creative.creative_id,
        status: String(body.status ?? 'ACTIVE'),
        reviewFrom: Date.now(),
        insights: { impressions: 0, reach: 0, clicks: 0, spend: 0, conversations: 0, leads: 0 },
      };
      ads.set(ad.id, ad);
      return send(res, 200, { id: ad.id });
    }
    if (req.method === 'POST' && resource === 'customaudiences') {
      const body = await readJson(req);
      const audience: Audience = { id: nextId('AUD'), subtype: String(body.subtype ?? 'CUSTOM'), members: new Set() };
      audiences.set(audience.id, audience);
      return send(res, 200, { id: audience.id });
    }
    return graphError(res, 404, 100, 'Unknown ads account path');
  }
  if (req.method === 'POST' && resource === 'welcome_message_sequences') {
    await readJson(req);
    return send(res, 200, { sequence_id: nextId('SEQ') });
  }

  // Lead forms (R9), with the page token or the system user token.
  if (id === ADS_PAGE && req.method === 'POST' && resource === 'leadgen_forms') {
    await readJson(req);
    const formId = nextId('FORM');
    forms.add(formId);
    return send(res, 200, { id: formId });
  }
  if (id === ADS_PAGE && req.method === 'POST' && resource === 'subscribed_apps') {
    await readJson(req);
    return send(res, 200, { success: true });
  }
  if (leads.has(id) && req.method === 'GET' && !resource) {
    if (token === ADS_TOKENS.noLeads) return graphError(res, 403, 200, 'Requires leads_retrieval permission');
    return send(res, 200, leadJson(leads.get(id)!));
  }
  if (forms.has(id) && req.method === 'GET' && resource === 'leads') {
    if (token === ADS_TOKENS.noLeads) return graphError(res, 403, 200, 'Requires leads_retrieval permission');
    const filter = JSON.parse(url.searchParams.get('filtering') ?? '[]') as Array<{ value?: number }>;
    const since = Number(filter[0]?.value ?? 0) * 1000;
    return send(res, 200, { data: [...leads.values()].filter((l) => l.formId === id && Date.parse(l.createdTime.replace('+0000', 'Z')) > since).map(leadJson) });
  }

  // Audiences (R8)
  const audience = audiences.get(id);
  if (audience) {
    if (resource === 'users' && (req.method === 'POST' || req.method === 'DELETE')) {
      const body = (await readJson(req)) as { payload?: { schema?: string; data?: string[] } };
      const data = body.payload?.data ?? [];
      if (body.payload?.schema !== 'PHONE_SHA256') return graphError(res, 400, 100, 'Unsupported schema');
      for (const hash of data) {
        if (req.method === 'POST') audience.members.add(hash);
        else audience.members.delete(hash);
      }
      return send(res, 200, { audience_id: id, num_received: data.length, num_invalid_entries: 0 });
    }
    if (req.method === 'GET' && !resource) {
      const size = audience.subtype === 'LOOKALIKE' ? 1_000_000 : audience.members.size;
      return send(res, 200, { id, approximate_count_lower_bound: size, approximate_count_upper_bound: size, operation_status: { code: 200, description: 'Normal' } });
    }
    if (req.method === 'DELETE' && !resource) {
      audiences.delete(id);
      return send(res, 200, { success: true });
    }
  }

  // Running (R6, R7): reads, changes and deletes of the objects made above.
  const campaign = campaigns.get(id);
  const adset = adsets.get(id);
  const ad = ads.get(id);
  if (req.method === 'GET' && campaign && resource === 'insights') return send(res, 200, { data: insights(id, url.searchParams.get('level') ?? 'campaign'), paging: {} });
  if (req.method === 'GET' && adset && resource === 'ads') {
    return send(res, 200, { data: [...ads.values()].filter((a) => a.adsetId === id).map((a) => ({ id: a.id, ...adStatus(a) })) });
  }
  if (req.method === 'GET' && !resource) {
    if (campaign) return send(res, 200, { id, effective_status: campaign.status, configured_status: campaign.status });
    if (adset) return send(res, 200, { id, effective_status: adset.status, configured_status: adset.status, daily_budget: String(adset.dailyBudget), end_time: adset.endTime });
    if (ad) return send(res, 200, { id, configured_status: ad.status, ...adStatus(ad) });
    if (videos.has(id)) return send(res, 200, { id, status: { video_status: 'ready', processing_progress: 100 }, picture: `https://mock.example/${id}.jpg` });
  }
  if (req.method === 'POST' && !resource && (campaign || adset || ad)) {
    const body = await readJson(req);
    if (campaign && body.status) campaign.status = String(body.status);
    if (adset) {
      if (body.status) adset.status = String(body.status);
      if (body.daily_budget !== undefined) {
        if (Number(body.daily_budget) < 400) return graphError(res, 400, 100, 'The daily budget is below the minimum of AED 4.00.');
        adset.dailyBudget = Number(body.daily_budget);
      }
      if (body.end_time !== undefined) adset.endTime = (body.end_time as string) ?? null;
    }
    if (ad) {
      if (body.status) ad.status = String(body.status);
      const creative = body.creative as { creative_id?: string } | undefined;
      if (creative?.creative_id) {
        ad.creativeId = creative.creative_id;
        ad.reviewFrom = Date.now();
      }
    }
    return send(res, 200, { success: true });
  }
  if (req.method === 'DELETE' && !resource && (campaign || adset || ad)) {
    campaigns.delete(id);
    adsets.delete(id);
    ads.delete(id);
    return send(res, 200, { success: true });
  }
  return graphError(res, 404, 100, 'Unknown ads path');
}
