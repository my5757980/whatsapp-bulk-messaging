// Store order rules (feature 006 US4, FR-023 - FR-033, research R7 - R9): one order shape from
// Shopify and WooCommerce payloads, the order stages, the phone choice, the 3-day rule and the
// template values taken from an order. Phone numbers are read by a function the caller passes in
// (libphonenumber in the api), so this file stays free of dependencies.

export type StorePlatformName = 'SHOPIFY' | 'WOOCOMMERCE';
export type OrderPaymentKind = 'COD' | 'PREPAID' | 'UNPAID';
export type OrderStage = 'ORDER_CONFIRMED' | 'ORDER_SHIPPED' | 'ORDER_DELIVERED' | 'ORDER_CANCELLED';
export type PhoneSource = 'shipping' | 'billing' | 'customer';

/** Events about orders last changed longer ago than this are not sent (FR-026). */
export const STALE_AFTER_MS = 3 * 24 * 3600 * 1000;
export const MAX_STORES = 5;

export interface OrderTracking {
  number: string | null;
  url: string | null;
  delivered: boolean;
}

export interface StoreOrderFacts {
  /** Shopify: the order's gid; WooCommerce: the order id. */
  externalId: string;
  /** As customers see it, e.g. "#1001" or "1001". */
  orderNumber: string;
  /** Decimal text, e.g. "120.50". */
  total: string;
  currency: string;
  paymentKind: OrderPaymentKind;
  /** The store's own status words, for the orders list. */
  status: string;
  placedAt: string;
  updatedAt: string;
  cancelled: boolean;
  customerName: string | null;
  firstName: string | null;
  phones: Partial<Record<PhoneSource, string>>;
  tracking: OrderTracking[];
  /** The customer agreed to marketing at checkout (used only when the store's consent text is confirmed). */
  acceptsMarketing: boolean;
  /** Up to three items, e.g. "2 × Shoes, Bag". */
  items: string | null;
  /** WooCommerce: where an unpaid order can be paid. */
  paymentUrl: string | null;
}

type Json = Record<string, unknown>;

const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
const fullName = (o: Json): string | null => [str(o.first_name), str(o.last_name)].filter(Boolean).join(' ') || null;

/** WooCommerce "_gmt" dates have no zone; they are UTC. */
const isoUtc = (v: unknown): string | null => {
  const s = str(v);
  if (!s) return null;
  const date = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

function itemsSummary(lines: unknown[], nameKey: 'title' | 'name'): string | null {
  const parts = lines.slice(0, 3).map((l) => {
    const line = obj(l);
    const name = str(line[nameKey]) ?? str(line.name) ?? 'Item';
    const qty = Number(line.quantity ?? 1);
    return qty > 1 ? `${qty} × ${name}` : name;
  });
  if (!parts.length) return null;
  const more = lines.length > 3 ? ` and ${lines.length - 3} more` : '';
  return `${parts.join(', ')}${more}`.slice(0, 300);
}

const COD_GATEWAY = /cash\s*on\s*delivery|\bcod\b/i;

/** A Shopify order webhook (REST JSON, as Shopify sends it) or the same shape built from GraphQL. */
export function mapShopifyOrder(payload: unknown): StoreOrderFacts {
  const o = obj(payload);
  const customer = obj(o.customer);
  const shipping = obj(o.shipping_address);
  const billing = obj(o.billing_address);
  const gateways = arr(o.payment_gateway_names).map((g) => String(g));
  const financial = str(o.financial_status) ?? 'pending';
  const paymentKind: OrderPaymentKind = gateways.some((g) => COD_GATEWAY.test(g))
    ? 'COD'
    : ['paid', 'partially_paid', 'authorized', 'partially_refunded', 'refunded'].includes(financial)
      ? 'PREPAID'
      : 'UNPAID';
  const consent = (v: unknown) => str(obj(v).state) === 'subscribed';
  const placedAt = isoUtc(o.created_at) ?? new Date(0).toISOString();
  return {
    externalId: str(o.admin_graphql_api_id) ?? `gid://shopify/Order/${str(o.id) ?? ''}`,
    orderNumber: str(o.name) ?? `#${str(o.order_number) ?? str(o.id) ?? ''}`,
    total: str(o.current_total_price) ?? str(o.total_price) ?? '0',
    currency: (str(o.currency) ?? 'USD').toUpperCase(),
    paymentKind,
    status: o.cancelled_at ? 'cancelled' : (str(o.fulfillment_status) ?? financial),
    placedAt,
    updatedAt: isoUtc(o.updated_at) ?? placedAt,
    cancelled: Boolean(o.cancelled_at),
    customerName: fullName(shipping) ?? fullName(customer) ?? fullName(billing),
    firstName: str(shipping.first_name) ?? str(customer.first_name) ?? str(billing.first_name),
    phones: compact({ shipping: str(shipping.phone), billing: str(billing.phone), customer: str(customer.phone) ?? str(o.phone) }),
    tracking: arr(o.fulfillments).map((f) => shopifyTracking(f)),
    acceptsMarketing: o.buyer_accepts_marketing === true || consent(customer.sms_marketing_consent) || consent(customer.email_marketing_consent),
    items: itemsSummary(arr(o.line_items), 'title'),
    paymentUrl: null,
  };
}

function shopifyTracking(fulfillment: unknown): OrderTracking {
  const f = obj(fulfillment);
  return {
    number: str(f.tracking_number) ?? str(arr(f.tracking_numbers)[0]),
    url: str(f.tracking_url) ?? str(arr(f.tracking_urls)[0]),
    delivered: (str(f.shipment_status) ?? '').toLowerCase() === 'delivered',
  };
}

/** A Shopify fulfillment webhook: the order it belongs to and its tracking. */
export function mapShopifyFulfillment(payload: unknown): { orderExternalId: string; tracking: OrderTracking } | null {
  const f = obj(payload);
  const orderId = str(f.order_id);
  if (!orderId) return null;
  return { orderExternalId: orderId.startsWith('gid://') ? orderId : `gid://shopify/Order/${orderId}`, tracking: shopifyTracking(f) };
}

/** A WooCommerce REST v3 order (webhook body or API answer). */
export function mapWooOrder(payload: unknown): StoreOrderFacts {
  const o = obj(payload);
  const billing = obj(o.billing);
  const shipping = obj(o.shipping);
  const status = str(o.status) ?? 'pending';
  const paid = Boolean(str(o.date_paid_gmt) ?? str(o.date_paid));
  const paymentKind: OrderPaymentKind = str(o.payment_method) === 'cod' ? 'COD' : paid || status === 'processing' || status === 'completed' ? 'PREPAID' : 'UNPAID';
  const meta = arr(o.meta_data).map(obj);
  const trackingItems = arr(meta.find((m) => m.key === '_wc_shipment_tracking_items')?.value);
  const placedAt = isoUtc(o.date_created_gmt) ?? isoUtc(o.date_created) ?? new Date(0).toISOString();
  return {
    externalId: str(o.id) ?? '',
    orderNumber: str(o.number) ?? str(o.id) ?? '',
    total: str(o.total) ?? '0',
    currency: (str(o.currency) ?? 'USD').toUpperCase(),
    paymentKind,
    status,
    placedAt,
    updatedAt: isoUtc(o.date_modified_gmt) ?? isoUtc(o.date_modified) ?? placedAt,
    cancelled: status === 'cancelled',
    customerName: fullName(shipping) ?? fullName(billing),
    firstName: str(shipping.first_name) ?? str(billing.first_name),
    phones: compact({ shipping: str(shipping.phone), billing: str(billing.phone) }),
    tracking: trackingItems.map((t) => {
      const item = obj(t);
      return { number: str(item.tracking_number), url: str(item.custom_tracking_link) ?? str(item.tracking_link), delivered: false };
    }),
    acceptsMarketing: false,
    items: itemsSummary(arr(o.line_items), 'name'),
    paymentUrl: str(o.payment_url),
  };
}

function compact(phones: Partial<Record<PhoneSource, string | null>>): Partial<Record<PhoneSource, string>> {
  const out: Partial<Record<PhoneSource, string>> = {};
  for (const [k, v] of Object.entries(phones) as Array<[PhoneSource, string | null]>) if (v) out[k] = v;
  return out;
}

export interface WooStatusMapping {
  /** The status that means shipped (default `completed`). */
  shippedStatus?: string | null;
  /** The status that means delivered (none by default). */
  deliveredStatus?: string | null;
}

/** The stages an order has reached, in order (R7, R8). A cancelled order is only cancelled. */
export function orderStages(order: StoreOrderFacts, platform: StorePlatformName, woo: WooStatusMapping = {}): OrderStage[] {
  if (order.cancelled) return ['ORDER_CANCELLED'];
  const stages: OrderStage[] = [];
  if (platform === 'SHOPIFY') {
    stages.push('ORDER_CONFIRMED');
    if (order.tracking.length) stages.push('ORDER_SHIPPED');
    if (order.tracking.some((t) => t.delivered)) stages.push('ORDER_DELIVERED');
    return stages;
  }
  const shipped = woo.shippedStatus ?? 'completed';
  const delivered = woo.deliveredStatus ?? null;
  const isShipped = order.status === shipped || (delivered !== null && order.status === delivered);
  if (order.status === 'processing' || order.status === 'on-hold' || isShipped) stages.push('ORDER_CONFIRMED');
  if (isShipped) stages.push('ORDER_SHIPPED');
  if (delivered !== null && order.status === delivered) stages.push('ORDER_DELIVERED');
  return stages;
}

/** Shipping phone, then billing, then the customer's, read with the store's default country (R9). */
export function choosePhone(
  phones: Partial<Record<PhoneSource, string>>,
  defaultCountry: string,
  normalize: (raw: string, country: string) => string | null,
): { e164: string; source: PhoneSource } | null {
  for (const source of ['shipping', 'billing', 'customer'] as const) {
    const raw = phones[source];
    const e164 = raw ? normalize(raw, defaultCountry) : null;
    if (e164) return { e164, source };
  }
  return null;
}

export function isStale(at: string | Date, now: Date = new Date()): boolean {
  const time = typeof at === 'string' ? new Date(at).getTime() : at.getTime();
  return Number.isFinite(time) && now.getTime() - time > STALE_AFTER_MS;
}

/** Order fields a template value can come from. */
export const ORDER_FIELDS = ['order_number', 'total', 'customer_name', 'first_name', 'items', 'tracking_number', 'tracking_url', 'payment_url', 'store_name'] as const;
export type OrderField = (typeof ORDER_FIELDS)[number];

export const ORDER_FIELD_LABELS: Record<OrderField, string> = {
  order_number: 'Order number',
  total: 'Order total',
  customer_name: 'Customer name',
  first_name: 'Customer first name',
  items: 'Items',
  tracking_number: 'Tracking number',
  tracking_url: 'Tracking link',
  payment_url: 'Payment link',
  store_name: 'Store name',
};

export function orderFieldValues(order: StoreOrderFacts, storeName: string): Record<OrderField, string> {
  const tracking = [...order.tracking].reverse().find((t) => t.number || t.url);
  return {
    order_number: order.orderNumber,
    total: `${order.total} ${order.currency}`,
    customer_name: order.customerName ?? '',
    first_name: order.firstName ?? '',
    items: order.items ?? '',
    tracking_number: tracking?.number ?? '',
    tracking_url: tracking?.url ?? '',
    payment_url: order.paymentUrl ?? '',
    store_name: storeName,
  };
}

export type OrderVariableSource = { source: 'order'; key: string } | { source: 'field'; key: string } | { source: 'static'; value: string };

/** Each template variable's text from an order field, a contact field (name, phone) or fixed text. */
export function resolveOrderValues(
  variableKeys: readonly string[],
  mapping: Record<string, OrderVariableSource>,
  values: Record<string, string>,
  contact: { name: string | null; phone: string },
): { ok: true; params: Record<string, string> } | { ok: false; missing: string } {
  const params: Record<string, string> = {};
  for (const variable of variableKeys) {
    const source = mapping[variable];
    const text =
      !source
        ? ''
        : source.source === 'static'
          ? source.value.trim()
          : source.source === 'order'
            ? (values[source.key] ?? '').trim()
            : source.key === 'name'
              ? (contact.name ?? '').trim()
              : source.key === 'phone'
                ? contact.phone
                : '';
    if (!text) return { ok: false, missing: variable };
    params[variable] = text;
  }
  return { ok: true, params };
}
