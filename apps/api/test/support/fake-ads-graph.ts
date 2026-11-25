import nock from 'nock';
import { META_BASE, META_VERSION } from './fixtures.js';
import { ADS_ACCOUNT_ID } from './ads.js';

// A small stateful Marketing API fake for 007 integration tests (contracts/meta-ads-graph.md): one
// nock dispatcher per method that keeps the objects made, so launches, rollbacks, status reads and
// resubmits can be checked. `failAt` makes the next create on that edge fail with Meta's error shape.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read nested response and Graph bodies
type Json = Record<string, any>;

export interface FakeAd {
  adsetId: string;
  creativeId: string;
  status: string;
  effective: string;
  feedback?: Json;
}

export class FakeAdsGraph {
  private n = 0;
  readonly creatives = new Map<string, Json>();
  readonly campaigns = new Map<string, Json>();
  readonly adsets = new Map<string, Json>();
  readonly ads = new Map<string, FakeAd>();
  readonly sequences: Json[] = [];
  readonly deleted: string[] = [];
  readonly resubmitted: string[] = [];
  readonly updates: Array<{ id: string; body: Json }> = [];
  /** Insight rows per Meta campaign id, as Meta returns them, by level (set by tests). */
  readonly insights = new Map<string, { ad: Json[]; campaign: Json[] }>();
  readonly insightCalls: Array<{ campaignId: string; level: string; since: string; until: string }> = [];
  /** Custom audiences and lookalikes with the hashes they hold; each users call is kept. */
  readonly audiences = new Map<string, { body: Json; members: Set<string> }>();
  readonly userCalls: Array<{ audienceId: string; method: string; count: number }> = [];
  /** Lead forms made on a page (body as sent), page subscriptions, and leads Meta would return. */
  readonly leadForms = new Map<string, Json>();
  readonly subscriptions: Array<{ pageId: string; body: Json; token: string }> = [];
  readonly leads = new Map<string, Json>();
  readonly order: string[] = [];
  images = 0;
  failAt: string | null = null;
  minBudget = 400;

  private nextId(prefix: string): string {
    this.n += 1;
    return `${prefix}${Date.now()}${this.n}`;
  }

  /** The ads made for one ad set, in creation order. */
  adsOf(adsetId: string): Array<[string, FakeAd]> {
    return [...this.ads].filter(([, a]) => a.adsetId === adsetId);
  }

  install(): void {
    const v = `/${META_VERSION}/`;
    const under = (p: string) => p.startsWith(v);
    nock(META_BASE).persist().get(under).query(true).reply(async (request: Request) => this.route(request));
    nock(META_BASE).persist().post(under).query(true).reply(async (request: Request) => this.route(request));
    nock(META_BASE).persist().delete(under).query(true).reply(async (request: Request) => this.route(request));
  }

  private async route(request: Request): Promise<[number, unknown]> {
    const url = new URL(request.url);
    const [, id, edge] = url.pathname.split('/').filter(Boolean);
    const method = request.method;
    const account = `act_${ADS_ACCOUNT_ID}`;
    const isJson = (request.headers.get('content-type') ?? '').includes('application/json');
    const body: Json = method !== 'GET' && isJson ? ((await request.json()) as Json) : {};
    if (method !== 'GET' && !isJson) await request.arrayBuffer();

    if (method === 'GET' && id === account && edge === 'minimum_budgets') return [200, { data: [{ currency: 'AED', min_daily_budget_imp: this.minBudget }] }];
    if (method === 'GET' && id === account && edge === 'delivery_estimate') return [200, { data: [{ estimate_mau_lower_bound: 120_000, estimate_mau_upper_bound: 150_000 }] }];
    if (method === 'GET' && id === 'search') {
      const q = (url.searchParams.get('q') ?? '').toLowerCase();
      if (url.searchParams.get('type') === 'adgeolocation') {
        return [200, { data: [{ key: 'AE', name: 'United Arab Emirates', type: 'country', country_code: 'AE' }, { key: '3005', name: 'Dubai', type: 'region', country_code: 'AE' }].filter((l) => l.name.toLowerCase().includes(q)) }];
      }
      return [200, { data: [{ id: '6003348604581', name: 'Shoes', audience_size_lower_bound: 1_200_000, audience_size_upper_bound: 1_400_000 }].filter((i) => i.name.toLowerCase().includes(q)) }];
    }
    if (method === 'POST' && id === account && edge === 'adimages') {
      this.images += 1;
      return [200, { images: { 'ad.jpg': { hash: `HASH${this.images}` } } }];
    }
    if (method === 'POST' && edge === 'welcome_message_sequences') {
      const sequenceId = this.nextId('SEQ');
      this.sequences.push({ wabaId: id, sequenceId, ...body });
      return [200, { sequence_id: sequenceId }];
    }
    if (method === 'POST' && id === account && edge === 'customaudiences') {
      if (this.failAt === edge) return [400, { error: { message: 'Terms of service not accepted', error_user_msg: 'Accept the custom audience terms first.', code: 2650 } }];
      const audienceId = this.nextId('AUD');
      this.audiences.set(audienceId, { body, members: new Set() });
      return [200, { id: audienceId }];
    }
    if (method === 'POST' && id === account && edge) {
      if (this.failAt === edge) return [400, { error: { message: 'Invalid parameter', error_user_msg: 'The audience is too narrow for this budget.', code: 100, error_subcode: 1487 } }];
      const madeId = this.nextId(edge.replace(/s$/, '').toUpperCase());
      this.order.push(edge);
      if (edge === 'adcreatives') this.creatives.set(madeId, body);
      if (edge === 'campaigns') this.campaigns.set(madeId, { ...body, status: body.status ?? 'ACTIVE' });
      if (edge === 'adsets') this.adsets.set(madeId, { ...body, status: body.status ?? 'ACTIVE' });
      if (edge === 'ads') this.ads.set(madeId, { adsetId: body.adset_id, creativeId: body.creative?.creative_id, status: body.status ?? 'ACTIVE', effective: 'PENDING_REVIEW' });
      return [200, { id: madeId }];
    }
    if (method === 'DELETE' && id && !edge) {
      this.deleted.push(id);
      this.audiences.delete(id);
      this.campaigns.delete(id);
      this.adsets.delete(id);
      this.ads.delete(id);
      this.creatives.delete(id);
      return [200, { success: true }];
    }
    if (method === 'POST' && id && !edge) {
      this.updates.push({ id, body });
      const ad = this.ads.get(id);
      if (ad) {
        if (body.creative?.creative_id) {
          ad.creativeId = body.creative.creative_id;
          ad.effective = 'PENDING_REVIEW';
          delete ad.feedback;
          this.resubmitted.push(id);
        }
        if (body.status) ad.status = body.status;
        return [200, { success: true }];
      }
      const object = this.campaigns.get(id) ?? this.adsets.get(id);
      if (object) {
        Object.assign(object, body);
        return [200, { success: true }];
      }
    }
    if (method === 'GET' && id && !edge) {
      const object = this.campaigns.get(id) ?? this.adsets.get(id);
      if (object) return [200, { id, effective_status: object.status, configured_status: object.status, daily_budget: object.daily_budget }];
    }
    if (method === 'GET' && id && edge === 'insights') {
      const level = url.searchParams.get('level') ?? 'campaign';
      const range = JSON.parse(url.searchParams.get('time_range') ?? '{}') as { since?: string; until?: string };
      this.insightCalls.push({ campaignId: id, level, since: range.since ?? '', until: range.until ?? '' });
      const rows = this.insights.get(id)?.[level === 'ad' ? 'ad' : 'campaign'] ?? [];
      return [200, { data: rows.filter((r) => (!range.since || r.date_start >= range.since) && (!range.until || r.date_start <= range.until)), paging: {} }];
    }
    const audience = id ? this.audiences.get(id) : undefined;
    if (audience && edge === 'users' && (method === 'POST' || method === 'DELETE')) {
      const hashes: string[] = body.payload?.data ?? [];
      if (body.payload?.schema !== 'PHONE_SHA256') return [400, { error: { message: 'Unsupported schema', code: 100 } }];
      this.userCalls.push({ audienceId: id!, method, count: hashes.length });
      for (const h of hashes) {
        if (method === 'POST') audience.members.add(h);
        else audience.members.delete(h);
      }
      return [200, { audience_id: id, num_received: hashes.length, num_invalid_entries: 0 }];
    }
    if (audience && !edge && method === 'GET') return [200, { id, approximate_count_lower_bound: audience.members.size }];
    if (method === 'GET' && id && edge === 'ads' && this.adsets.has(id)) {
      return [200, { data: this.adsOf(id).map(([adId, a]) => ({ id: adId, effective_status: a.effective, ...(a.feedback ? { ad_review_feedback: a.feedback } : {}) })) }];
    }
    if (method === 'POST' && id && edge === 'leadgen_forms') {
      if (this.failAt === edge) return [400, { error: { message: 'Terms not accepted', error_user_msg: 'Accept the lead ads terms for the page first.', code: 100 } }];
      const formId = this.nextId('FORM');
      this.leadForms.set(formId, { pageId: id, token: request.headers.get('authorization'), ...body });
      return [200, { id: formId }];
    }
    if (method === 'POST' && id && edge === 'subscribed_apps') {
      this.subscriptions.push({ pageId: id, body, token: request.headers.get('authorization') ?? '' });
      return [200, { success: true }];
    }
    if (method === 'GET' && id && !edge && this.leads.has(id)) return [200, this.leads.get(id)];
    if (method === 'GET' && id && edge === 'leads') {
      const filter = JSON.parse(url.searchParams.get('filtering') ?? '[]') as Array<{ value?: number }>;
      const since = Number(filter[0]?.value ?? 0);
      return [200, { data: [...this.leads.values()].filter((l) => l.form_id === id && Date.parse(String(l.created_time).replace('+0000', 'Z')) / 1000 > since) }];
    }
    return [404, { error: { message: `Unknown fake Graph path ${method} ${url.pathname}`, code: 100 } }];
  }
}
