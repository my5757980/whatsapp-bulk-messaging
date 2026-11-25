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
    if (method === 'DELETE' && id) {
      this.deleted.push(id);
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
    if (method === 'GET' && id && edge === 'ads' && this.adsets.has(id)) {
      return [200, { data: this.adsOf(id).map(([adId, a]) => ({ id: adId, effective_status: a.effective, ...(a.feedback ? { ad_review_feedback: a.feedback } : {}) })) }];
    }
    return [404, { error: { message: `Unknown fake Graph path ${method} ${url.pathname}`, code: 100 } }];
  }
}
