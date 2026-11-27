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
const ABANDONED_CHECKOUTS = `query AbandonedCheckouts($query: String!) {
  abandonedCheckouts(first: 5, query: $query) {
    nodes { id createdAt updatedAt completedAt abandonedCheckoutUrl totalPriceSet { shopMoney { amount currencyCode } } customer { firstName lastName phone } lineItems(first: 3) { nodes { title quantity } } }
  }
}`;
const TAGS_ADD = `mutation TagsAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { node { id } userErrors { field message } } }`;
const METAFIELDS_SET = `mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { key } userErrors { field message } } }`;
const ORDER_CANCEL = `mutation OrderCancel($orderId: ID!, $reason: OrderCancelReason!, $refund: Boolean!, $restock: Boolean!, $notifyCustomer: Boolean) {
  orderCancel(orderId: $orderId, reason: $reason, refund: $refund, restock: $restock, notifyCustomer: $notifyCustomer) { job { id } orderCancelUserErrors { field message } }
}`;
/** Feature 008 (R5): an order paid through its pay link; needs write_orders, as tags and cancel. */
const ORDER_MARK_AS_PAID = `mutation OrderMarkAsPaid($input: OrderMarkAsPaidInput!) {
  orderMarkAsPaid(input: $input) { order { id displayFinancialStatus } userErrors { field message } }
}`;
/** Feature 008 (R9): active products with their variants for the catalog fill; needs read_products. */
const PRODUCTS = `query Products($after: String) {
  products(first: 50, after: $after, query: "status:active") {
    pageInfo { hasNextPage endCursor }
    nodes {
      id title description status onlineStoreUrl
      featuredMedia { preview { image { url } } }
      variants(first: 100) { nodes { id title price availableForSale media(first: 1) { nodes { preview { image { url } } } } } }
    }
  }
}`;
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

  /** COD answers (US5): a tag on the order. */
  async tagOrder(store: Pick<StoreConnection, 'baseUrl'>, token: string, gid: string, tags: string[]): Promise<void> {
    const data = await this.graphql<{ tagsAdd: { userErrors: Array<{ message: string }> } }>(store.baseUrl, token, TAGS_ADD, { id: gid, tags });
    const error = data.tagsAdd.userErrors[0];
    if (error) throw new StoreApiError(`Shopify refused the tag: ${error.message}`.slice(0, 200), null);
  }

  /** COD answers (US5): the whatsapp.cod_status metafield. */
  async setCodStatus(store: Pick<StoreConnection, 'baseUrl'>, token: string, gid: string, value: string): Promise<void> {
    const data = await this.graphql<{ metafieldsSet: { userErrors: Array<{ message: string }> } }>(store.baseUrl, token, METAFIELDS_SET, {
      metafields: [{ ownerId: gid, namespace: 'whatsapp', key: 'cod_status', type: 'single_line_text_field', value }],
    });
    const error = data.metafieldsSet.userErrors[0];
    if (error) throw new StoreApiError(`Shopify refused the metafield: ${error.message}`.slice(0, 200), null);
  }

  /** Automatic cancel (US5): reason customer, restock, no refund, the customer is not emailed. */
  async cancelOrder(store: Pick<StoreConnection, 'baseUrl'>, token: string, gid: string): Promise<void> {
    const data = await this.graphql<{ orderCancel: { orderCancelUserErrors: Array<{ message: string }> } }>(store.baseUrl, token, ORDER_CANCEL, {
      orderId: gid,
      reason: 'CUSTOMER',
      refund: false,
      restock: true,
      notifyCustomer: false,
    });
    const error = data.orderCancel.orderCancelUserErrors[0];
    if (error) throw new StoreApiError(`Shopify refused to cancel the order: ${error.message}`.slice(0, 200), null);
  }

  /** Feature 008: marks the order paid for its outstanding balance (a pay link payment). */
  async markOrderPaid(store: Pick<StoreConnection, 'baseUrl'>, token: string, gid: string): Promise<void> {
    const data = await this.graphql<{ orderMarkAsPaid: { userErrors: Array<{ message: string }> } }>(store.baseUrl, token, ORDER_MARK_AS_PAID, { input: { id: gid } });
    const error = data.orderMarkAsPaid.userErrors[0];
    if (error) throw new StoreApiError(`Shopify refused to mark the order paid: ${error.message}`.slice(0, 200), null);
  }

  /** Feature 008: the shop's currency (the catalog fill prices items in it). */
  async shopCurrency(store: Pick<StoreConnection, 'baseUrl'>, token: string): Promise<string> {
    const data = await this.graphql<{ shop: { currencyCode?: string } }>(store.baseUrl, token, SHOP_INFO);
    return (data.shop.currencyCode ?? 'AED').toLowerCase();
  }

  /** Feature 008 (R9): every active product with its variants, at most 20 pages of 50. */
  async products(store: Pick<StoreConnection, 'baseUrl'>, token: string): Promise<Json[]> {
    const out: Json[] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const data: { products: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: Json[] } } = await this.graphql(store.baseUrl, token, PRODUCTS, { after });
      out.push(...data.products.nodes);
      if (!data.products.pageInfo.hasNextPage || !data.products.pageInfo.endCursor) break;
      after = data.products.pageInfo.endCursor;
    }
    return out;
  }

  /** A checkout read again at reminder time (US6): payloads can lack details, and it may be completed by now. */
  async abandonedCheckout(store: Pick<StoreConnection, 'baseUrl'>, token: string, checkoutId: string): Promise<Json | null> {
    const data = await this.graphql<{ abandonedCheckouts: { nodes: Array<Json & { id?: string }> } }>(store.baseUrl, token, ABANDONED_CHECKOUTS, { query: `id:${checkoutId}` });
    return data.abandonedCheckouts.nodes.find((n) => String(n.id ?? '').split('/').pop() === checkoutId) ?? null;
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
