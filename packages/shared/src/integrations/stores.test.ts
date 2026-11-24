import { describe, expect, it } from 'vitest';
import {
  choosePhone,
  isStale,
  mapShopifyFulfillment,
  mapShopifyOrder,
  mapWooOrder,
  orderFieldValues,
  orderStages,
  resolveOrderValues,
} from './stores.js';

// T042 (feature 006 US4, research R7 - R9): Shopify and WooCommerce orders in one shape, stages,
// the phone choice, the 3-day rule and template values from order fields.

const shopifyOrder = {
  id: 5501,
  admin_graphql_api_id: 'gid://shopify/Order/5501',
  name: '#1001',
  total_price: '120.50',
  currency: 'aed',
  financial_status: 'pending',
  fulfillment_status: null,
  cancelled_at: null,
  created_at: '2026-11-24T08:00:00+04:00',
  updated_at: '2026-11-24T08:05:00+04:00',
  payment_gateway_names: ['Cash on Delivery (COD)'],
  buyer_accepts_marketing: false,
  customer: { first_name: 'Layla', last_name: 'Hassan', phone: null, sms_marketing_consent: { state: 'subscribed' } },
  shipping_address: { first_name: 'Layla', last_name: 'Hassan', phone: '050 123 4567' },
  billing_address: { phone: '+971 52 765 4321' },
  line_items: [
    { title: 'Shoes', quantity: 2 },
    { title: 'Bag', quantity: 1 },
  ],
  fulfillments: [],
};

const wooOrder = {
  id: 734,
  number: '734',
  status: 'processing',
  currency: 'AED',
  total: '89.00',
  payment_method: 'bacs',
  date_paid_gmt: '2026-11-24T05:00:00',
  date_created_gmt: '2026-11-24T04:59:00',
  date_modified_gmt: '2026-11-24T05:01:00',
  billing: { first_name: 'Omar', last_name: 'Ali', phone: '0551234567' },
  shipping: { first_name: '', last_name: '', phone: '' },
  line_items: [{ name: 'Hat', quantity: 1 }],
  meta_data: [{ key: '_wc_shipment_tracking_items', value: [{ tracking_number: 'TRK-9', custom_tracking_link: 'https://track.example/TRK-9' }] }],
  payment_url: 'https://shop.example/checkout/order-pay/734',
};

describe('store orders', () => {
  it('maps a Shopify order to the common shape', () => {
    expect(mapShopifyOrder(shopifyOrder)).toEqual({
      externalId: 'gid://shopify/Order/5501',
      orderNumber: '#1001',
      total: '120.50',
      currency: 'AED',
      paymentKind: 'COD',
      status: 'pending',
      placedAt: '2026-11-24T04:00:00.000Z',
      updatedAt: '2026-11-24T04:05:00.000Z',
      cancelled: false,
      customerName: 'Layla Hassan',
      firstName: 'Layla',
      phones: { shipping: '050 123 4567', billing: '+971 52 765 4321' },
      tracking: [],
      acceptsMarketing: true,
      items: '2 × Shoes, Bag',
      paymentUrl: null,
    });
    expect(mapShopifyOrder({ ...shopifyOrder, payment_gateway_names: ['shopify_payments'], financial_status: 'paid' }).paymentKind).toBe('PREPAID');
    expect(mapShopifyOrder({ ...shopifyOrder, payment_gateway_names: ['manual'] }).paymentKind).toBe('UNPAID');
  });

  it('maps a WooCommerce order, with UTC dates and shipment tracking', () => {
    const order = mapWooOrder(wooOrder);
    expect(order).toMatchObject({
      externalId: '734',
      orderNumber: '734',
      total: '89.00',
      currency: 'AED',
      paymentKind: 'PREPAID',
      status: 'processing',
      placedAt: '2026-11-24T04:59:00.000Z',
      updatedAt: '2026-11-24T05:01:00.000Z',
      customerName: 'Omar Ali',
      phones: { billing: '0551234567' },
      tracking: [{ number: 'TRK-9', url: 'https://track.example/TRK-9', delivered: false }],
      acceptsMarketing: false,
      paymentUrl: 'https://shop.example/checkout/order-pay/734',
    });
    expect(mapWooOrder({ ...wooOrder, payment_method: 'cod', date_paid_gmt: null }).paymentKind).toBe('COD');
    expect(mapWooOrder({ ...wooOrder, status: 'pending', date_paid_gmt: null }).paymentKind).toBe('UNPAID');
  });

  it('finds the stages: confirmed, shipped with tracking, delivered from shipmentStatus, cancelled', () => {
    const base = mapShopifyOrder(shopifyOrder);
    expect(orderStages(base, 'SHOPIFY')).toEqual(['ORDER_CONFIRMED']);
    const shipped = mapShopifyOrder({ ...shopifyOrder, fulfillments: [{ tracking_number: 'X1', tracking_url: 'https://t.example/X1', shipment_status: 'in_transit' }] });
    expect(orderStages(shipped, 'SHOPIFY')).toEqual(['ORDER_CONFIRMED', 'ORDER_SHIPPED']);
    const delivered = mapShopifyOrder({ ...shopifyOrder, fulfillments: [{ tracking_number: 'X1', shipment_status: 'delivered' }] });
    expect(orderStages(delivered, 'SHOPIFY')).toEqual(['ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED']);
    expect(orderStages(mapShopifyOrder({ ...shopifyOrder, cancelled_at: '2026-11-24T09:00:00Z' }), 'SHOPIFY')).toEqual(['ORDER_CANCELLED']);
    expect(mapShopifyFulfillment({ order_id: 5501, tracking_number: 'X1', shipment_status: 'delivered' })).toEqual({
      orderExternalId: 'gid://shopify/Order/5501',
      tracking: { number: 'X1', url: null, delivered: true },
    });
  });

  it("uses WooCommerce's chosen statuses for shipped and delivered", () => {
    const at = (status: string) => mapWooOrder({ ...wooOrder, status });
    expect(orderStages(at('processing'), 'WOOCOMMERCE')).toEqual(['ORDER_CONFIRMED']);
    expect(orderStages(at('on-hold'), 'WOOCOMMERCE')).toEqual(['ORDER_CONFIRMED']);
    expect(orderStages(at('pending'), 'WOOCOMMERCE')).toEqual([]);
    expect(orderStages(at('completed'), 'WOOCOMMERCE')).toEqual(['ORDER_CONFIRMED', 'ORDER_SHIPPED']);
    expect(orderStages(at('completed'), 'WOOCOMMERCE', { shippedStatus: 'shipped' })).toEqual([]);
    expect(orderStages(at('delivered'), 'WOOCOMMERCE', { deliveredStatus: 'delivered' })).toEqual(['ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED']);
    expect(orderStages(at('cancelled'), 'WOOCOMMERCE')).toEqual(['ORDER_CANCELLED']);
  });

  it('chooses the shipping phone, then billing, then the customer phone, with the default country', () => {
    const normalize = (raw: string, country: string) => {
      const digits = raw.replace(/\D/g, '');
      if (raw.trim().startsWith('+')) return `+${digits}`;
      return country === 'AE' && digits.startsWith('05') && digits.length === 10 ? `+971${digits.slice(1)}` : null;
    };
    expect(choosePhone({ shipping: '050 123 4567', billing: '+971 52 765 4321' }, 'AE', normalize)).toEqual({ e164: '+971501234567', source: 'shipping' });
    expect(choosePhone({ shipping: 'n/a', billing: '+971 52 765 4321' }, 'AE', normalize)).toEqual({ e164: '+971527654321', source: 'billing' });
    expect(choosePhone({ customer: '0559876543' }, 'AE', normalize)).toEqual({ e164: '+971559876543', source: 'customer' });
    expect(choosePhone({}, 'AE', normalize)).toBeNull();
  });

  it('treats orders last changed more than 3 days ago as stale', () => {
    const now = new Date('2026-11-24T12:00:00Z');
    expect(isStale('2026-11-21T12:00:01Z', now)).toBe(false);
    expect(isStale('2026-11-21T11:59:59Z', now)).toBe(true);
  });

  it('fills template values from order fields, contact fields and fixed text', () => {
    const shipped = mapShopifyOrder({ ...shopifyOrder, fulfillments: [{ tracking_number: 'X1', tracking_url: 'https://t.example/X1' }] });
    const values = orderFieldValues(shipped, 'Desert Shoes');
    expect(values).toMatchObject({ order_number: '#1001', total: '120.50 AED', first_name: 'Layla', tracking_number: 'X1', tracking_url: 'https://t.example/X1', store_name: 'Desert Shoes', items: '2 × Shoes, Bag' });
    const mapping = {
      'BODY.1': { source: 'field' as const, key: 'name' },
      'BODY.2': { source: 'order' as const, key: 'order_number' },
      'BUTTON.0.1': { source: 'order' as const, key: 'tracking_url' },
      'BODY.3': { source: 'static' as const, value: 'Thank you!' },
    };
    expect(resolveOrderValues(['BODY.1', 'BODY.2', 'BODY.3', 'BUTTON.0.1'], mapping, values, { name: 'Layla', phone: '+971501234567' })).toEqual({
      ok: true,
      params: { 'BODY.1': 'Layla', 'BODY.2': '#1001', 'BODY.3': 'Thank you!', 'BUTTON.0.1': 'https://t.example/X1' },
    });
    expect(resolveOrderValues(['BODY.1'], { 'BODY.1': { source: 'order', key: 'tracking_number' } }, orderFieldValues(mapShopifyOrder(shopifyOrder), 'S'), { name: null, phone: '+1' })).toEqual({
      ok: false,
      missing: 'BODY.1',
    });
  });
});
