import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../common/prisma/prisma.service.js';
import type { StoreConnection } from '../../../../generated/prisma/client.js';
import { StoreApiError, StoreHttp, type ShopifyCredentials } from '../store-http.js';
import { ORDER_FIELDS_FRAGMENT, graphqlOrderToRest } from './shopify-mapping.js';

// The Shopify GraphQL Admin API (feature 006 US4, research R7): the client credentials token
// (24 hours, renewed when less than an hour is left), webhook subscriptions, orders, and the order
// actions COD confirmation uses. Every call goes through the safe HTTP client.

type Json = Record<string, unknown>;

export const SHOPIFY_TOPICS = ['ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'FULFILLMENTS_CREATE', 'FULFILLMENTS_UPDATE', 'CHECKOUTS_CREATE', 'CHECKOUTS_UPDATE'] as const;

const WEBHOOK_CREATE = `mutation WebhookCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
  webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) { webhookSubscription { id topic uri } userErrors { field message } }
}`;
const WEBHOOK_LIST = `query WebhookList { webhookSubscriptions(first: 100) { nodes { id topic uri } } }`;
const WEBHOOK_DELETE = `mutation WebhookDelete($id: ID!) { webhookSubscriptionDelete(id: $id) { deletedWebhookSubscriptionId userErrors { field message } } }`;
const SHOP_INFO = `query ShopInfo { shop { name currencyCode } }`;
const ORDER_BY_ID = `query OrderById($id: ID!) { order(id: $id) { ...OrderFields } }
${ORDER_FIELDS_FRAGMENT}`;
const ORDERS_SINCE = `query OrdersSince($query: String!, $after: String) {
  orders(first: 50, after: $after, query: $query, sortKey: UPDATED_AT) { nodes { ...OrderFields } pageInfo { hasNextPage endCursor } }
}
${ORDER_FIELDS_FRAGMENT}`;

/** At most this many pages of 50 orders per check (the rest come on the next one). */
const MAX_PAGES = 5;

@Injectable()
export class ShopifyClient {
  constructor(
    private readonly prisma: PrismaService,
    private readonly http: StoreHttp,
  ) {}

  /** The client credentials grant of a Dev Dashboard app in the store's organization. */
  async exchangeToken(baseUrl: string, clientId: string, clientSecret: string): Promise<{ token: string; expiresAt: Date }> {
    const answer = await this.http.json<{ access_token?: string; expires_in?: number }>({
      method: 'POST',
      url: `${baseUrl}/admin/oauth/access_token`,
      body: { client_id: clientId, client_secret: clientSecret, grant_type: 'client_credentials' },
    });
    if (!answer.access_token) throw new StoreApiError('Shopify did not give an access token: check the app and its client secret', null);
    return { token: answer.access_token, expiresAt: new Date(Date.now() + (answer.expires_in ?? 86_399) * 1000) };
  }

  async graphql<T>(baseUrl: string, token: string, query: string, variables: Json = {}): Promise<T> {
    const answer = await this.http.json<{ data?: T; errors?: unknown }>({
      method: 'POST',
      url: `${baseUrl}/admin/api/${this.http.shopifyApiVersion}/graphql.json`,
      headers: { 'x-shopify-access-token': token },
      body: { query, variables },
    });
    if (answer.errors) {
      const first = Array.isArray(answer.errors) ? (answer.errors[0] as { message?: string } | undefined)?.message : String(answer.errors);
      throw new StoreApiError(`Shopify refused a request: ${first ?? 'unknown error'}`.slice(0, 200), null);
    }
    if (!answer.data) throw new StoreApiError('Shopify answered without data', null);
    return answer.data;
  }

  /** The store's current token: renewed when less than `withinMs` is left (client credentials), or the legacy token. */
  async tokenFor(store: Pick<StoreConnection, 'id' | 'baseUrl' | 'credentialsEncrypted' | 'accessTokenEncrypted' | 'tokenExpiresAt'>, withinMs = 5 * 60_000): Promise<string> {
    const credentials = this.http.open<ShopifyCredentials>(store.credentialsEncrypted);
    if (!credentials.clientId) {
      if (!credentials.accessToken) throw new StoreApiError('The store has no Shopify access token', null);
      return credentials.accessToken;
    }
    const current = store.accessTokenEncrypted ? this.http.open<{ token: string }>(store.accessTokenEncrypted).token : null;
    if (current && store.tokenExpiresAt && store.tokenExpiresAt.getTime() - Date.now() > withinMs) return current;
    const fresh = await this.exchangeToken(store.baseUrl, credentials.clientId, credentials.clientSecret);
    await this.prisma.storeConnection.update({ where: { id: store.id }, data: { accessTokenEncrypted: this.http.seal({ token: fresh.token }), tokenExpiresAt: fresh.expiresAt } });
    return fresh.token;
  }

  async shopName(baseUrl: string, token: string): Promise<string> {
    const data = await this.graphql<{ shop: { name: string } }>(baseUrl, token, SHOP_INFO);
    return data.shop.name;
  }

  /** Creates the subscriptions that are missing; returns how many were created. */
  async ensureSubscriptions(store: Pick<StoreConnection, 'id' | 'baseUrl'>, token: string): Promise<number> {
    const uri = this.http.receiverUrl('shopify', store.id);
    const existing = await this.graphql<{ webhookSubscriptions: { nodes: Array<{ topic: string; uri?: string }> } }>(store.baseUrl, token, WEBHOOK_LIST);
    const have = new Set(existing.webhookSubscriptions.nodes.filter((n) => n.uri === uri).map((n) => n.topic));
    let created = 0;
    for (const topic of SHOPIFY_TOPICS) {
      if (have.has(topic)) continue;
      const data = await this.graphql<{ webhookSubscriptionCreate: { userErrors: Array<{ message: string }> } }>(store.baseUrl, token, WEBHOOK_CREATE, {
        topic,
        webhookSubscription: { uri, format: 'JSON' },
      });
      const error = data.webhookSubscriptionCreate.userErrors[0];
      if (error) throw new StoreApiError(`Shopify refused the ${topic} webhook: ${error.message}`.slice(0, 200), null);
      created += 1;
    }
    return created;
  }

  /** Removes the subscriptions that point to this store's receiver. */
  async removeSubscriptions(store: Pick<StoreConnection, 'id' | 'baseUrl'>, token: string): Promise<void> {
    const uri = this.http.receiverUrl('shopify', store.id);
    const existing = await this.graphql<{ webhookSubscriptions: { nodes: Array<{ id: string; uri?: string }> } }>(store.baseUrl, token, WEBHOOK_LIST);
    for (const node of existing.webhookSubscriptions.nodes.filter((n) => n.uri === uri)) await this.graphql(store.baseUrl, token, WEBHOOK_DELETE, { id: node.id });
  }

  /** One order, in the REST shape of Shopify webhooks; null when Shopify has no such order. */
  async order(store: Pick<StoreConnection, 'baseUrl'>, token: string, gid: string): Promise<Json | null> {
    const data = await this.graphql<{ order: unknown }>(store.baseUrl, token, ORDER_BY_ID, { id: gid });
    return data.order ? graphqlOrderToRest(data.order) : null;
  }

  /** Orders changed since a time, oldest change first, in the REST shape. */
  async ordersSince(store: Pick<StoreConnection, 'baseUrl'>, token: string, since: Date): Promise<Json[]> {
    const out: Json[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const data: { orders: { nodes: unknown[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } } } = await this.graphql(store.baseUrl, token, ORDERS_SINCE, {
        query: `updated_at:>'${since.toISOString()}'`,
        after,
      });
      out.push(...data.orders.nodes.map(graphqlOrderToRest));
      if (!data.orders.pageInfo.hasNextPage) break;
      after = data.orders.pageInfo.endCursor;
    }
    return out;
  }
}
