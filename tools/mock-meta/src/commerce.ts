// Feature 008 (T005, T067, T082; contracts/meta-commerce-graph.md "mock-meta"): the catalog, commerce
// settings, items_batch and WhatsApp Flows routes for "mock-token", plus the limits of the commerce
// interactive messages (product, product_list, catalog_message, cta_url, flow).
// Catalog 900000000000001 holds 40 seeded products shp-101 … shp-140: shp-103, shp-117 and shp-129 are
// out of stock, shp-133 is rejected, and prices use mixed text formats. Every WhatsApp account has the
// catalog except ids ending in NOCAT.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { env } from './env.js';

export const MOCK_CATALOG_ID = '900000000000001';

interface Product {
  id: string;
  retailer_id: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  image_url: string;
  url: string;
  availability: string;
  visibility: string;
  review_status: string;
}

interface MockFlow {
  id: string;
  wabaId: string;
  name: string;
  categories: string[];
  status: 'DRAFT' | 'PUBLISHED' | 'DEPRECATED';
  json: unknown;
  validation_errors: unknown[];
}

const OUT_OF_STOCK = new Set(['shp-103', 'shp-117', 'shp-129']);
const REJECTED = new Set(['shp-133']);
const KINDS = ['Linen Shirt', 'Abaya', 'Oud Perfume', 'Leather Watch', 'Silk Scarf'];

function priceText(minor: number, index: number): string {
  const major = (minor / 100).toFixed(2);
  const grouped = Number(major).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  switch (index % 5) {
    case 0:
      return `AED ${major}`;
    case 1:
      return `AED${grouped}`;
    case 2:
      return `${grouped} AED`;
    case 3:
      return minor % 100 === 0 ? `${minor / 100} AED` : `${grouped} AED`;
    default:
      return `د.إ.‏ ${major}`;
  }
}

const products = new Map<string, Product>();
function seed(): void {
  products.clear();
  for (let i = 1; i <= 40; i++) {
    const retailer = `shp-${100 + i}`;
    const minor = i % 7 === 0 ? 123_450 : 4_500 + i * 2_500;
    products.set(retailer, {
      id: `${7_000_000_000 + i}`,
      retailer_id: retailer,
      name: `${KINDS[i % KINDS.length]} ${100 + i}`,
      description: `Mock product ${100 + i}`,
      price: priceText(minor, i),
      currency: 'AED',
      image_url: `https://example.com/products/${retailer}.jpg`,
      url: `https://example.com/p/${retailer}`,
      availability: OUT_OF_STOCK.has(retailer) ? 'out of stock' : 'in stock',
      visibility: 'published',
      review_status: REJECTED.has(retailer) ? 'rejected' : 'approved',
    });
  }
}
seed();

const commerceSettings = new Map<string, { is_cart_enabled: boolean; is_catalog_visible: boolean }>();
const batches = new Map<string, { checks: number; errors: Array<{ line: number; id: string; message: string }>; invalid: string[] }>();
const flows = new Map<string, MockFlow>();
let counter = 0;
const nextId = (kind: string) => `MOCK${kind}${Date.now()}${(counter++).toString().padStart(3, '0')}`;

function send(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
  return true;
}

function graphError(res: ServerResponse, status: number, code: number, message: string): true {
  return send(res, status, { error: { message, type: 'OAuthException', code, fbtrace_id: nextId('trace') } });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Graph accepts JSON or form bodies; values that hold JSON (requests, categories) arrive as strings. */
async function readParams(req: IncomingMessage, url: URL): Promise<Record<string, unknown>> {
  const raw = await readBody(req);
  const out: Record<string, unknown> = Object.fromEntries(url.searchParams);
  if (!raw) return out;
  if ((req.headers['content-type'] ?? '').includes('application/json')) return { ...out, ...(JSON.parse(raw) as Record<string, unknown>) };
  return { ...out, ...Object.fromEntries(new URLSearchParams(raw)) };
}

const asJson = <T>(value: unknown): T | undefined => {
  if (typeof value !== 'string') return value as T | undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
};

const chars = (value: unknown): number => (typeof value === 'string' ? [...value].length : 0);
const within = (value: unknown, min: number, max: number): boolean => typeof value === 'string' && chars(value) >= min && chars(value) <= max;

interface CommerceInteractive {
  type?: string;
  header?: { type?: string; text?: string };
  body?: { text?: string };
  footer?: { text?: string };
  action?: {
    name?: string;
    catalog_id?: string;
    product_retailer_id?: string;
    sections?: Array<{ title?: string; product_items?: Array<{ product_retailer_id?: string }> }>;
    parameters?: Record<string, unknown>;
  };
}

/** Meta's limits for the commerce interactive types; null when the type is not one of them. */
export function commerceInteractiveProblem(input: unknown): string | undefined | null {
  const interactive = input as CommerceInteractive;
  const type = interactive?.type;
  if (!['product', 'product_list', 'catalog_message', 'cta_url', 'flow'].includes(type ?? '')) return null;
  if (interactive.body !== undefined && !within(interactive.body.text, 1, 1024)) return "Param interactive['body']['text'] must have 1 to 1024 characters";
  if (interactive.footer !== undefined && !within(interactive.footer.text, 1, 60)) return "Param interactive['footer']['text'] must have 1 to 60 characters";
  const action = interactive.action ?? {};
  const known = (id: string | undefined) => (id ? products.has(id) : false);
  if (type === 'product') {
    if (action.catalog_id !== MOCK_CATALOG_ID) return 'Unknown catalog_id';
    if (!known(action.product_retailer_id)) return `Product ${action.product_retailer_id ?? '(none)'} not found in the catalog`;
    return undefined;
  }
  if (type === 'product_list') {
    if (interactive.header?.type !== 'text' || !within(interactive.header.text, 1, 60)) return "Param interactive['header'] must be text with 1 to 60 characters";
    if (!interactive.body) return "Param interactive['body'] is required";
    if (action.catalog_id !== MOCK_CATALOG_ID) return 'Unknown catalog_id';
    const sections = action.sections ?? [];
    if (sections.length < 1 || sections.length > 10) return 'Sections must have 1 to 10 items';
    const items = sections.flatMap((s) => s.product_items ?? []);
    if (items.length < 1 || items.length > 30) return 'A product list holds 1 to 30 products';
    for (const section of sections) {
      if ((section.product_items ?? []).length < 1) return 'Each section needs at least one product';
      if (sections.length > 1 && !within(section.title, 1, 24)) return 'Section titles must have 1 to 24 characters';
    }
    const missing = items.find((item) => !known(item.product_retailer_id));
    return missing ? `Product ${missing.product_retailer_id ?? '(none)'} not found in the catalog` : undefined;
  }
  if (type === 'catalog_message') {
    if (!interactive.body) return "Param interactive['body'] is required";
    if (action.name !== 'catalog_message') return "Param interactive['action']['name'] must be catalog_message";
    const thumb = action.parameters?.thumbnail_product_retailer_id as string | undefined;
    return thumb !== undefined && !known(thumb) ? `Product ${thumb} not found in the catalog` : undefined;
  }
  if (type === 'cta_url') {
    if (action.name !== 'cta_url') return "Param interactive['action']['name'] must be cta_url";
    if (!within(action.parameters?.display_text, 1, 20)) return 'display_text must have 1 to 20 characters';
    const target = action.parameters?.url;
    return typeof target === 'string' && /^https?:\/\//.test(target) ? undefined : 'url must be an http(s) address';
  }
  // flow
  if (!interactive.body) return "Param interactive['body'] is required";
  if (action.name !== 'flow') return "Param interactive['action']['name'] must be flow";
  const p = action.parameters ?? {};
  if (p.flow_message_version !== '3') return 'flow_message_version must be "3"';
  if (!within(p.flow_cta, 1, 30)) return 'flow_cta must have 1 to 30 characters';
  if (!p.flow_id === !p.flow_name) return 'Send exactly one of flow_id and flow_name';
  if (p.flow_id && flows.get(String(p.flow_id))?.status !== 'PUBLISHED') return 'The flow is not published';
  return undefined;
}

function flowProblems(json: unknown): Array<Record<string, unknown>> {
  const problem = (message: string, path: string) => ({ error: 'INVALID_PROPERTY_VALUE', error_type: 'FLOW_JSON_ERROR', message, line_start: 1, line_end: 1, column_start: 1, column_end: 1, pointers: [{ path }] });
  const flow = json as { version?: string; screens?: Array<{ id?: string; terminal?: boolean; layout?: { children?: Array<{ type?: string; label?: string }> } }> } | undefined;
  if (!flow || typeof flow !== 'object') return [problem('Flow JSON is not valid JSON', '')];
  if (!flow.version) return [problem('Property "version" is required', 'version')];
  const screens = flow.screens ?? [];
  if (screens.length === 0) return [problem('At least one screen is required', 'screens')];
  const out: Array<Record<string, unknown>> = [];
  if (!screens.some((s) => s.terminal === true)) out.push(problem('At least one screen must be terminal', 'screens'));
  screens.forEach((screen, i) => {
    if (!screen.id || !/^[A-Z][A-Z0-9_]*$/.test(screen.id)) out.push(problem('Screen id must be upper case letters, digits and _', `screens[${i}].id`));
    const children = screen.layout?.children ?? [];
    if (!children.some((c) => c.type === 'Footer')) out.push(problem('Every screen needs a Footer', `screens[${i}].layout`));
    children.forEach((child, j) => {
      if (child.type === 'TextInput' && chars(child.label) > 20) out.push(problem('TextInput label must have at most 20 characters', `screens[${i}].layout.children[${j}].label`));
    });
  });
  return out;
}

export async function handleCommerce(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (req.method === 'POST' && url.pathname === '/mock/commerce/reset') {
    seed();
    commerceSettings.clear();
    batches.clear();
    flows.clear();
    return send(res, 200, { reset: true });
  }
  const [version, id, resource] = url.pathname.split('/').filter(Boolean);
  if (!version?.startsWith('v') || !id) return false;
  const isCommerce =
    resource === 'product_catalogs' ||
    resource === 'whatsapp_commerce_settings' ||
    resource === 'flows' ||
    id === MOCK_CATALOG_ID ||
    id.startsWith('MOCKFLOW');
  if (!isCommerce) return false;
  if ((req.headers.authorization ?? '') !== `Bearer ${env.token}`) return graphError(res, 401, 190, 'Invalid OAuth access token');

  // Catalog (R8)
  if (req.method === 'GET' && resource === 'product_catalogs') {
    return send(res, 200, { data: id.endsWith('NOCAT') ? [] : [{ id: MOCK_CATALOG_ID, name: 'Mock Catalog' }] });
  }
  if (id === MOCK_CATALOG_ID && req.method === 'GET' && !resource) return send(res, 200, { id: MOCK_CATALOG_ID, name: 'Mock Catalog' });
  if (id === MOCK_CATALOG_ID && req.method === 'GET' && resource === 'products') {
    const limit = Math.min(100, Number(url.searchParams.get('limit') ?? '25'));
    const all = [...products.values()];
    const start = Number(url.searchParams.get('after') ?? '0') || 0;
    const page = all.slice(start, start + limit);
    const next = start + limit < all.length ? String(start + limit) : undefined;
    return send(res, 200, {
      data: page,
      paging: { cursors: { before: String(start), after: next ?? String(all.length) }, ...(next ? { next: `${env.baseUrl}${url.pathname}?limit=${limit}&after=${next}` } : {}) },
    });
  }

  // Commerce settings per number
  if (resource === 'whatsapp_commerce_settings') {
    const current = commerceSettings.get(id) ?? { is_cart_enabled: true, is_catalog_visible: false };
    if (req.method === 'GET') return send(res, 200, { data: [{ ...current, id: `MOCKCS${id}` }] });
    if (req.method === 'POST') {
      const params = await readParams(req, url);
      const flag = (v: unknown, fallback: boolean) => (v === undefined ? fallback : v === true || v === 'true');
      commerceSettings.set(id, { is_cart_enabled: flag(params.is_cart_enabled, current.is_cart_enabled), is_catalog_visible: flag(params.is_catalog_visible, current.is_catalog_visible) });
      return send(res, 200, { success: true });
    }
  }

  // Store fill (R9)
  if (id === MOCK_CATALOG_ID && req.method === 'POST' && resource === 'items_batch') {
    const params = await readParams(req, url);
    if (params.item_type !== 'PRODUCT_ITEM') return graphError(res, 400, 100, 'item_type must be PRODUCT_ITEM');
    const requests = asJson<Array<{ method?: string; data?: Record<string, string> }>>(params.requests) ?? [];
    const errors: Array<{ line: number; id: string; message: string }> = [];
    requests.forEach((request, line) => {
      const data = request.data ?? {};
      const retailer = data.id ?? '';
      if (request.method === 'DELETE') {
        products.delete(retailer);
        return;
      }
      if (!data.price) {
        errors.push({ line, id: retailer, message: 'price is required' });
        return;
      }
      const [amount, currency] = data.price.split(' ');
      const existing = products.get(retailer);
      products.set(retailer, {
        id: existing?.id ?? `${8_000_000_000 + products.size}`,
        retailer_id: retailer,
        name: data.title ?? existing?.name ?? retailer,
        description: data.description ?? existing?.description ?? '',
        price: `${currency ?? 'AED'} ${amount}`,
        currency: currency ?? 'AED',
        image_url: data.image_link ?? existing?.image_url ?? '',
        url: data.link ?? existing?.url ?? '',
        availability: data.availability ?? 'in stock',
        visibility: 'published',
        review_status: 'approved',
      });
    });
    const handle = nextId('BATCH');
    batches.set(handle, { checks: 0, errors, invalid: errors.map((e) => e.id) });
    return send(res, 200, { handles: [handle] });
  }
  if (id === MOCK_CATALOG_ID && req.method === 'GET' && resource === 'check_batch_request_status') {
    const batch = batches.get(url.searchParams.get('handle') ?? '');
    if (!batch) return graphError(res, 400, 100, 'Unknown handle');
    batch.checks += 1;
    const finished = batch.checks >= 2;
    return send(res, 200, {
      data: [
        {
          status: finished ? 'finished' : 'started',
          errors: finished ? batch.errors : [],
          ids_of_invalid_requests: finished && url.searchParams.get('load_ids_of_invalid_requests') === 'true' ? batch.invalid : [],
        },
      ],
    });
  }

  // WhatsApp Flows (R12)
  if (req.method === 'POST' && resource === 'flows') {
    const params = await readParams(req, url);
    const name = String(params.name ?? '');
    if (!name) return graphError(res, 400, 100, 'name is required');
    if ([...flows.values()].some((f) => f.wabaId === id && f.name === name)) return graphError(res, 400, 100, 'Flow with the same name already exists');
    const json = asJson<unknown>(params.flow_json);
    const problems = json === undefined ? [] : flowProblems(json);
    const flowId = nextId('FLOW');
    const publish = params.publish === true || params.publish === 'true';
    flows.set(flowId, {
      id: flowId,
      wabaId: id,
      name,
      categories: asJson<string[]>(params.categories) ?? [],
      status: publish && json !== undefined && problems.length === 0 ? 'PUBLISHED' : 'DRAFT',
      json,
      validation_errors: problems,
    });
    return send(res, 200, { id: flowId, success: true, ...(problems.length ? { validation_errors: problems } : {}) });
  }
  if (id.startsWith('MOCKFLOW')) {
    const flow = flows.get(id);
    if (!flow) return graphError(res, 404, 100, 'Unknown flow');
    if (req.method === 'GET' && !resource) return send(res, 200, { id: flow.id, name: flow.name, status: flow.status, validation_errors: flow.validation_errors, json_version: '7.3' });
    if (req.method === 'POST' && resource === 'deprecate') {
      if (flow.status !== 'PUBLISHED') return graphError(res, 400, 100, 'Only published flows can be deprecated');
      flow.status = 'DEPRECATED';
      return send(res, 200, { success: true });
    }
    if (req.method === 'DELETE' && !resource) {
      if (flow.status !== 'DRAFT') return graphError(res, 400, 100, 'Only draft flows can be deleted');
      flows.delete(id);
      return send(res, 200, { success: true });
    }
  }
  return graphError(res, 404, 100, 'Unknown commerce path');
}
