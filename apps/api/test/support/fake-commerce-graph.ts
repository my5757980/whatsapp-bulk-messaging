import nock from 'nock';
import { META_BASE, META_VERSION } from './fixtures.js';

// Feature 008 (T018, contracts/meta-commerce-graph.md): a stateful Graph for the catalog, commerce
// settings, items_batch and the Flows API, in the pattern of FakeAdsGraph. It answers only commerce
// paths, so the 001 message mocks (mockMetaSends) keep working beside it.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;

export const FAKE_CATALOG_ID = '900000000000001';

export interface FakeProduct {
  id: string;
  retailer_id: string;
  name: string;
  description?: string;
  price: string;
  currency: string;
  image_url?: string;
  url?: string;
  availability: string;
  visibility?: string;
  review_status?: string;
}

export class FakeCommerceGraph {
  /** WABA id → catalogs connected to it; WABAs not listed have the fake catalog. */
  readonly wabaCatalogs = new Map<string, Array<{ id: string; name: string }>>();
  readonly products = new Map<string, FakeProduct>();
  readonly settings = new Map<string, { is_cart_enabled: boolean; is_catalog_visible: boolean }>();
  readonly batches: Array<{ handle: string; requests: Json[]; checks: number; errors: Json[]; invalid: string[] }> = [];
  readonly flows = new Map<string, { wabaId: string; name: string; categories: string[]; json: Json; status: string; validationErrors: Json[] }>();
  readonly calls: Array<{ method: string; path: string }> = [];
  /** Set to make product reads fail (e.g. 190 for a token without catalog_management). */
  productsError: { status: number; code: number; message: string } | null = null;
  batchError: { status: number; code: number; message: string } | null = null;
  /** Validation errors Meta returns for the next created flow. */
  nextFlowErrors: Json[] = [];
  private n = 0;

  constructor(productCount = 40) {
    for (let i = 1; i <= productCount; i++) {
      const retailer = `shp-${100 + i}`;
      this.products.set(retailer, {
        id: `${7_000_000_000 + i}`,
        retailer_id: retailer,
        name: `Product ${100 + i}`,
        price: i % 2 === 0 ? `AED ${(50 + i).toFixed(2)}` : `${(50 + i).toFixed(2)} AED`,
        currency: 'AED',
        image_url: `https://img.test/${retailer}.jpg`,
        availability: [3, 17, 29].includes(i) ? 'out of stock' : 'in stock',
        visibility: 'published',
        review_status: i === 33 ? 'rejected' : 'approved',
      });
    }
  }

  install(): this {
    const v = `/${META_VERSION}/`;
    const commerce = (p: string) => {
      if (!p.startsWith(v)) return false;
      const [id, edge] = p.slice(v.length).split('?')[0]!.split('/');
      return (
        edge === 'product_catalogs' ||
        edge === 'whatsapp_commerce_settings' ||
        edge === 'flows' ||
        id === FAKE_CATALOG_ID ||
        (id ?? '').startsWith('FLOW') ||
        [...this.wabaCatalogs.values()].flat().some((c) => c.id === id)
      );
    };
    for (const method of ['get', 'post', 'delete'] as const) {
      const scope = nock(META_BASE).persist();
      scope[method](commerce)
        .query(true)
        .reply(async (req: Request) => this.route(req));
    }
    return this;
  }

  private async route(req: Request): Promise<[number, unknown]> {
    const url = new URL(req.url);
    const [, id = '', edge] = url.pathname.split('/').filter(Boolean);
    const method = req.method;
    this.calls.push({ method, path: url.pathname });
    const isJson = (req.headers.get('content-type') ?? '').includes('application/json');
    const body: Json = method !== 'GET' && isJson ? ((await req.json()) as Json) : {};
    if (method !== 'GET' && !isJson) await req.arrayBuffer();
    const error = (status: number, code: number, message: string): [number, unknown] => [status, { error: { message, type: 'OAuthException', code, fbtrace_id: 'TRACE' } }];

    if (method === 'GET' && edge === 'product_catalogs') return [200, { data: this.wabaCatalogs.get(id) ?? [{ id: FAKE_CATALOG_ID, name: 'Fake Catalog' }] }];
    if (edge === 'whatsapp_commerce_settings') {
      const current = this.settings.get(id) ?? { is_cart_enabled: true, is_catalog_visible: false };
      if (method === 'GET') return [200, { data: [{ ...current, id: `CS${id}` }] }];
      this.settings.set(id, { is_cart_enabled: url.searchParams.get('is_cart_enabled') === 'true', is_catalog_visible: url.searchParams.get('is_catalog_visible') === 'true' });
      return [200, { success: true }];
    }
    if (method === 'GET' && !edge && (id === FAKE_CATALOG_ID || [...this.wabaCatalogs.values()].flat().some((c) => c.id === id))) {
      return [200, { id, name: id === FAKE_CATALOG_ID ? 'Fake Catalog' : ([...this.wabaCatalogs.values()].flat().find((c) => c.id === id)?.name ?? id) }];
    }
    if (method === 'GET' && edge === 'products') {
      if (this.productsError) return error(this.productsError.status, this.productsError.code, this.productsError.message);
      const all = [...this.products.values()];
      const limit = Number(url.searchParams.get('limit') ?? '25');
      const start = Number(url.searchParams.get('after') ?? '0') || 0;
      const page = all.slice(start, start + limit);
      const more = start + limit < all.length;
      return [200, { data: page, paging: { cursors: { before: String(start), after: String(start + limit) }, ...(more ? { next: `${META_BASE}${url.pathname}?after=${start + limit}` } : {}) } }];
    }
    if (method === 'POST' && edge === 'items_batch') {
      if (this.batchError) return error(this.batchError.status, this.batchError.code, this.batchError.message);
      const requests: Json[] = Array.isArray(body.requests) ? body.requests : [];
      const errors: Json[] = [];
      requests.forEach((r: Json, line: number) => {
        const data: Json = r.data ?? {};
        if (r.method === 'DELETE') {
          this.products.delete(String(data.id));
          return;
        }
        if (!data.price) {
          errors.push({ line, id: data.id, message: 'price is required' });
          return;
        }
        const [amount, currency] = String(data.price).split(' ');
        this.products.set(String(data.id), {
          id: this.products.get(String(data.id))?.id ?? `8${String(++this.n).padStart(9, '0')}`,
          retailer_id: String(data.id),
          name: String(data.title ?? data.id),
          description: data.description,
          price: `${currency ?? 'AED'} ${amount}`,
          currency: currency ?? 'AED',
          image_url: data.image_link,
          url: data.link,
          availability: String(data.availability ?? 'in stock'),
          visibility: 'published',
          review_status: 'approved',
        });
      });
      const handle = `HANDLE${++this.n}`;
      this.batches.push({ handle, requests, checks: 0, errors, invalid: errors.map((e) => String(e.id)) });
      return [200, { handles: [handle] }];
    }
    if (method === 'GET' && edge === 'check_batch_request_status') {
      const batch = this.batches.find((b) => b.handle === url.searchParams.get('handle'));
      if (!batch) return error(400, 100, 'Unknown handle');
      batch.checks += 1;
      const finished = batch.checks >= 2;
      return [200, { data: [{ status: finished ? 'finished' : 'started', errors: finished ? batch.errors : [], ids_of_invalid_requests: finished ? batch.invalid : [] }] }];
    }
    if (method === 'POST' && edge === 'flows') {
      const name = String(body.name ?? '');
      if ([...this.flows.values()].some((f) => f.wabaId === id && f.name === name)) return error(400, 100, 'Flow with the same name already exists');
      const flowId = `FLOW${++this.n}`;
      const validationErrors = this.nextFlowErrors;
      this.nextFlowErrors = [];
      this.flows.set(flowId, {
        wabaId: id,
        name,
        categories: Array.isArray(body.categories) ? body.categories : [],
        json: typeof body.flow_json === 'string' ? (JSON.parse(body.flow_json) as Json) : {},
        status: body.publish && validationErrors.length === 0 ? 'PUBLISHED' : 'DRAFT',
        validationErrors,
      });
      return [200, { id: flowId, success: true, ...(validationErrors.length ? { validation_errors: validationErrors } : {}) }];
    }
    if (id.startsWith('FLOW')) {
      const flow = this.flows.get(id);
      if (!flow) return error(404, 100, 'Unknown flow');
      if (method === 'GET') return [200, { id, name: flow.name, status: flow.status, validation_errors: flow.validationErrors, json_version: '7.3' }];
      if (method === 'POST' && edge === 'deprecate') {
        if (flow.status !== 'PUBLISHED') return error(400, 100, 'Only published flows can be deprecated');
        flow.status = 'DEPRECATED';
        return [200, { success: true }];
      }
      if (method === 'DELETE') {
        if (flow.status !== 'DRAFT') return error(400, 100, 'Only draft flows can be deleted');
        this.flows.delete(id);
        return [200, { success: true }];
      }
    }
    return error(404, 100, `Unknown fake commerce path ${method} ${url.pathname}`);
  }
}
