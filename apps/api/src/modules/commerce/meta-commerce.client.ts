// A thin Graph client for commerce (feature 008, research R8–R12, contracts/meta-commerce-graph.md):
// the WhatsApp account's catalog, the product copy, commerce settings, items_batch for the store fill,
// and the Flows API for WhatsApp Forms. Same version, timeout and error parsing as 001 and 007.
// Messages themselves go through the 001 send path.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { MetaApiError, toNetworkError } from '../meta/meta-graph.client.js';

/** Graph error 80009: too many calls to this catalog; the job backs off and tries again (R9). */
export const CATALOG_RATE_LIMIT_CODE = 80009;
export const isCatalogRateLimited = (error: unknown): boolean => error instanceof MetaApiError && error.code === CATALOG_RATE_LIMIT_CODE;

/** *(verify)* the product field list against the Graph catalog reference (T017). */
export const PRODUCT_FIELDS = 'id,retailer_id,name,description,price,sale_price,currency,image_url,url,availability,visibility,review_status';

export interface CatalogRef {
  id: string;
  name: string;
}

export interface CatalogItem {
  metaId: string;
  retailerId: string;
  name: string;
  description: string | null;
  price: string | null;
  salePrice: string | null;
  currency: string | null;
  imageUrl: string | null;
  url: string | null;
  availability: string;
  visibility: string | null;
  reviewStatus: string | null;
}

export interface CommerceSettings {
  cartEnabled: boolean;
  catalogVisible: boolean;
}

export interface BatchRequest {
  method: 'CREATE' | 'UPDATE' | 'DELETE';
  data: Record<string, string>;
}

export interface BatchStatus {
  status: string;
  errors: Array<{ id: string | null; message: string }>;
  invalidIds: string[];
}

export interface FlowValidationError {
  error: string;
  message: string;
  pointers: string[];
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

function toValidationErrors(value: unknown): FlowValidationError[] {
  // *(verify)* the validation_errors fields against the Flows API reference (T017, T083).
  return list(value).map((raw) => {
    const e = obj(raw);
    return {
      error: str(e.error) ?? str(e.error_type) ?? 'INVALID',
      message: str(e.message) ?? 'Meta refused this form',
      pointers: list(e.pointers).map((p) => str(obj(p).path) ?? '').filter(Boolean),
    };
  });
}

@Injectable()
export class MetaCommerceClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Optional() @Inject('META_COMMERCE_CLIENT_OPTIONS') options?: { timeoutMs?: number },
  ) {
    this.baseUrl = `${config.META_GRAPH_BASE_URL.replace(/\/$/, '')}/${config.META_GRAPH_API_VERSION}`;
    this.timeoutMs = options?.timeoutMs ?? 20_000;
  }

  // ---------- Catalog (R8) ----------

  /** The catalog connected to a WhatsApp account (Meta allows one per WABA). */
  async wabaCatalogs(token: string, wabaId: string): Promise<CatalogRef[]> {
    const body = obj(await this.request('GET', `/${wabaId}/product_catalogs`, token, { query: { fields: 'id,name' } }));
    return list(body.data).map((c) => ({ id: str(obj(c).id) ?? '', name: str(obj(c).name) ?? '' })).filter((c) => c.id);
  }

  async catalog(token: string, catalogId: string): Promise<CatalogRef> {
    const c = obj(await this.request('GET', `/${catalogId}`, token, { query: { fields: 'id,name' } }));
    return { id: str(c.id) ?? catalogId, name: str(c.name) ?? catalogId };
  }

  /** One page of products; `next` is the cursor for the following page, or null. */
  async products(token: string, catalogId: string, after?: string | null): Promise<{ items: CatalogItem[]; next: string | null }> {
    const query: Record<string, string> = { fields: PRODUCT_FIELDS, limit: '100' };
    if (after) query.after = after;
    const body = obj(await this.request('GET', `/${catalogId}/products`, token, { query }));
    const items = list(body.data).map((raw): CatalogItem => {
      const p = obj(raw);
      return {
        metaId: str(p.id) ?? '',
        retailerId: str(p.retailer_id) ?? '',
        name: str(p.name) ?? str(p.retailer_id) ?? '',
        description: str(p.description),
        price: str(p.price),
        salePrice: str(p.sale_price),
        currency: str(p.currency),
        imageUrl: str(p.image_url),
        url: str(p.url),
        availability: str(p.availability) ?? 'in stock',
        visibility: str(p.visibility),
        reviewStatus: str(p.review_status),
      };
    });
    const paging = obj(body.paging);
    const next = str(paging.next) ? str(obj(paging.cursors).after) : null;
    return { items: items.filter((i) => i.retailerId), next };
  }

  async commerceSettings(token: string, phoneNumberId: string): Promise<CommerceSettings> {
    const body = obj(await this.request('GET', `/${phoneNumberId}/whatsapp_commerce_settings`, token));
    const s = obj(list(body.data)[0]);
    return { cartEnabled: s.is_cart_enabled !== false, catalogVisible: s.is_catalog_visible === true };
  }

  async setCommerceSettings(token: string, phoneNumberId: string, settings: CommerceSettings): Promise<void> {
    await this.request('POST', `/${phoneNumberId}/whatsapp_commerce_settings`, token, {
      query: { is_cart_enabled: String(settings.cartEnabled), is_catalog_visible: String(settings.catalogVisible) },
    });
  }

  // ---------- Store fill (R9) ----------

  /** *(verify)* the per-call maximum and the price format ("150.00 AED") against items_batch (T017, T069). */
  async itemsBatch(token: string, catalogId: string, requests: readonly BatchRequest[]): Promise<string | null> {
    const body = obj(await this.request('POST', `/${catalogId}/items_batch`, token, { json: { item_type: 'PRODUCT_ITEM', requests } }));
    return str(list(body.handles)[0]);
  }

  async batchStatus(token: string, catalogId: string, handle: string): Promise<BatchStatus> {
    const body = obj(await this.request('GET', `/${catalogId}/check_batch_request_status`, token, { query: { handle, load_ids_of_invalid_requests: 'true' } }));
    const s = obj(list(body.data)[0]);
    return {
      status: (str(s.status) ?? 'unknown').toLowerCase(),
      errors: list(s.errors).map((e) => ({ id: str(obj(e).id) ?? str(obj(e).retailer_id), message: str(obj(e).message) ?? 'error' })),
      invalidIds: list(s.ids_of_invalid_requests).map((id) => String(id)),
    };
  }

  // ---------- WhatsApp Flows (R12) ----------

  /** Creates and publishes a flow in one call; Meta returns validation errors instead of publishing. */
  async createFlow(token: string, wabaId: string, input: { name: string; categories: string[]; flowJson: unknown; publish: boolean }): Promise<{ id: string; validationErrors: FlowValidationError[] }> {
    const body = obj(
      await this.request('POST', `/${wabaId}/flows`, token, {
        json: { name: input.name, categories: input.categories, flow_json: JSON.stringify(input.flowJson), publish: input.publish },
      }),
    );
    return { id: str(body.id) ?? '', validationErrors: toValidationErrors(body.validation_errors) };
  }

  async flow(token: string, flowId: string): Promise<{ id: string; name: string; status: string; validationErrors: FlowValidationError[] }> {
    const f = obj(await this.request('GET', `/${flowId}`, token, { query: { fields: 'id,name,status,validation_errors,json_version' } }));
    return { id: str(f.id) ?? flowId, name: str(f.name) ?? '', status: str(f.status) ?? 'DRAFT', validationErrors: toValidationErrors(f.validation_errors) };
  }

  async deprecateFlow(token: string, flowId: string): Promise<void> {
    await this.request('POST', `/${flowId}/deprecate`, token);
  }

  async deleteFlow(token: string, flowId: string): Promise<void> {
    await this.request('DELETE', `/${flowId}`, token);
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, token: string, opts: { query?: Record<string, string>; json?: unknown } = {}): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw toNetworkError(error);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    if (!res.ok) {
      const e = obj(obj(body).error);
      throw new MetaApiError(
        res.status,
        typeof e.code === 'number' ? e.code : undefined,
        typeof e.error_subcode === 'number' ? e.error_subcode : undefined,
        str(e.error_user_msg) ?? str(e.message) ?? `Graph API HTTP ${res.status}`,
        str(e.fbtrace_id) ?? undefined,
      );
    }
    return body;
  }
}
