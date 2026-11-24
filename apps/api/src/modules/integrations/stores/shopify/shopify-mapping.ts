// Shopify GraphQL Admin API orders in the REST shape that Shopify webhooks use (feature 006 US4,
// research R7), so one mapping (`mapShopifyOrder` in @wbm/shared) reads both.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {});
const list = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);

/** The order fields the platform reads (GraphQL fragment). */
export const ORDER_FIELDS_FRAGMENT = `
fragment OrderFields on Order {
  id
  name
  createdAt
  updatedAt
  cancelledAt
  displayFinancialStatus
  paymentGatewayNames
  customerAcceptsMarketing
  currentTotalPriceSet { shopMoney { amount currencyCode } }
  customer { firstName lastName phone }
  shippingAddress { firstName lastName phone }
  billingAddress { phone }
  lineItems(first: 3) { nodes { title quantity } }
  fulfillments(first: 10) { trackingInfo(first: 3) { number url } displayStatus }
}`;

function address(v: unknown): Json | null {
  const a = obj(v);
  return Object.keys(a).length ? { first_name: a.firstName ?? null, last_name: a.lastName ?? null, phone: a.phone ?? null } : null;
}

export function graphqlOrderToRest(node: unknown): Json {
  const o = obj(node);
  const gid = String(o.id ?? '');
  const money = obj(obj(o.currentTotalPriceSet).shopMoney);
  return {
    id: Number(gid.split('/').pop()) || gid,
    admin_graphql_api_id: gid,
    name: o.name,
    total_price: money.amount ?? '0',
    currency: money.currencyCode ?? 'USD',
    financial_status: String(o.displayFinancialStatus ?? 'PENDING').toLowerCase(),
    cancelled_at: o.cancelledAt ?? null,
    created_at: o.createdAt,
    updated_at: o.updatedAt,
    payment_gateway_names: Array.isArray(o.paymentGatewayNames) ? o.paymentGatewayNames : [],
    buyer_accepts_marketing: o.customerAcceptsMarketing === true,
    customer: address(o.customer),
    shipping_address: address(o.shippingAddress),
    billing_address: address(o.billingAddress),
    line_items: list(obj(o.lineItems).nodes).map((l) => ({ title: l.title, quantity: l.quantity })),
    fulfillments: list(o.fulfillments).map((f) => {
      const info = list(f.trackingInfo)[0] ?? {};
      return { tracking_number: info.number ?? null, tracking_url: info.url ?? null, shipment_status: f.displayStatus === 'DELIVERED' ? 'delivered' : 'in_transit' };
    }),
  };
}
