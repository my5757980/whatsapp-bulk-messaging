import { Injectable } from '@nestjs/common';
import type { StoreConnection } from '../../../../generated/prisma/client.js';
import { StoreApiError, StoreHttp, type WooCredentials } from '../store-http.js';

// The WooCommerce REST API v3 (feature 006 US4, research R8): keys over https with Basic auth,
// webhooks the platform creates with its own secret, and orders changed since the last check.

type Json = Record<string, unknown>;

export const WOO_TOPICS = ['order.created', 'order.updated'] as const;
const MAX_PAGES = 5;

interface WooWebhook {
  id: number;
  topic: string;
  delivery_url: string;
  status: string;
}

@Injectable()
export class WooClient {
  constructor(private readonly http: StoreHttp) {}

  private headers(credentials: WooCredentials): Record<string, string> {
    return { authorization: `Basic ${Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString('base64')}` };
  }

  private api(baseUrl: string, path: string): string {
    return `${baseUrl}/wp-json/wc/v3${path}`;
  }

  /** The site's name from the WordPress index. */
  async siteName(baseUrl: string): Promise<string> {
    const index = await this.http.json<{ name?: string }>({ method: 'GET', url: `${baseUrl}/wp-json/` });
    return (index.name ?? '').trim() || new URL(baseUrl).hostname;
  }

  /** The keys can read orders (an admin key with read/write is needed for webhooks too). */
  async testKeys(baseUrl: string, credentials: WooCredentials): Promise<void> {
    await this.http.json({ method: 'GET', url: this.api(baseUrl, '/orders?per_page=1'), headers: this.headers(credentials) });
  }

  private async ours(store: Pick<StoreConnection, 'id' | 'baseUrl'>, credentials: WooCredentials): Promise<WooWebhook[]> {
    const url = this.http.receiverUrl('woocommerce', store.id);
    const hooks = await this.http.json<WooWebhook[]>({ method: 'GET', url: this.api(store.baseUrl, '/webhooks?per_page=100'), headers: this.headers(credentials) });
    return (Array.isArray(hooks) ? hooks : []).filter((h) => h.delivery_url === url);
  }

  /** Creates missing webhooks and sets disabled or paused ones active again; returns how many it changed. */
  async ensureWebhooks(store: Pick<StoreConnection, 'id' | 'baseUrl'>, credentials: WooCredentials, secret: string): Promise<number> {
    const existing = await this.ours(store, credentials);
    let changed = 0;
    for (const topic of WOO_TOPICS) {
      const hook = existing.find((h) => h.topic === topic);
      if (!hook) {
        await this.http.json({
          method: 'POST',
          url: this.api(store.baseUrl, '/webhooks'),
          headers: this.headers(credentials),
          body: { name: `WhatsApp platform: ${topic}`, topic, delivery_url: this.http.receiverUrl('woocommerce', store.id), secret, status: 'active' },
        });
        changed += 1;
      } else if (hook.status !== 'active') {
        await this.http.json({ method: 'PUT', url: this.api(store.baseUrl, `/webhooks/${hook.id}`), headers: this.headers(credentials), body: { status: 'active' } });
        changed += 1;
      }
    }
    return changed;
  }

  async removeWebhooks(store: Pick<StoreConnection, 'id' | 'baseUrl'>, credentials: WooCredentials): Promise<void> {
    for (const hook of await this.ours(store, credentials)) {
      await this.http.json({ method: 'DELETE', url: this.api(store.baseUrl, `/webhooks/${hook.id}?force=true`), headers: this.headers(credentials) });
    }
  }

  /** COD answers (US5): a private order note. */
  async addNote(store: Pick<StoreConnection, 'baseUrl'>, credentials: WooCredentials, orderId: string, note: string): Promise<void> {
    await this.http.json({ method: 'POST', url: this.api(store.baseUrl, `/orders/${orderId}/notes`), headers: this.headers(credentials), body: { note, customer_note: false } });
  }

  /** COD answers (US5): meta values and, for automatic cancel, the status. */
  async updateOrder(store: Pick<StoreConnection, 'baseUrl'>, credentials: WooCredentials, orderId: string, changes: Record<string, unknown>): Promise<void> {
    await this.http.json({ method: 'PUT', url: this.api(store.baseUrl, `/orders/${orderId}`), headers: this.headers(credentials), body: changes });
  }

  /** Orders changed since a time (GMT), oldest change first. */
  async ordersSince(store: Pick<StoreConnection, 'baseUrl'>, credentials: WooCredentials, since: Date): Promise<Json[]> {
    const out: Json[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ modified_after: since.toISOString().slice(0, 19), dates_are_gmt: 'true', orderby: 'modified', order: 'asc', per_page: '50', page: String(page) });
      const orders = await this.http.json<Json[]>({ method: 'GET', url: this.api(store.baseUrl, `/orders?${query.toString()}`), headers: this.headers(credentials) });
      if (!Array.isArray(orders)) throw new StoreApiError('WooCommerce answered the order list with something unexpected', null);
      out.push(...orders);
      if (orders.length < 50) break;
    }
    return out;
  }
}
