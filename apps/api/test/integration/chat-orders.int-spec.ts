import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { clearCommerce, orderMessage, seedCatalog, seedGateway, seedPaymentSettings } from '../support/commerce.js';
import { FAKE_CATALOG_ID } from '../support/fake-commerce-graph.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, seedNumber, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T073 (feature 008 US6, FR-026 – FR-029, research R11): a cart becomes a chat order with names from
// the catalog copy and its total; automatic mode sends the link inside the inbound job; review mode
// waits for edits, the link or a cancel; warnings stop automatic links; paying, expiry and refunds are
// mirrored, with the tag, events and journey.

type Json = Record<string, unknown>;

describe('Chat orders (008 US6)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let stripe: FakeStripe;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let tagId: string;

  const api = (method: 'get' | 'post' | 'patch', url: string, body?: object) => {
    const req = admin.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', admin.csrf).send(body ?? {});
  };
  const deliver = async (body: Json) => ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, body));
  const cart = async (phone: string, items: Array<{ retailerId: string; quantity: number; price: number }>, text?: string) => {
    await deliver(orderMessage(number.phoneNumberId, phone.slice(1), items, text));
    return ctx.prisma.chatOrder.findFirstOrThrow({ where: { contact: { phoneE164: phone } }, orderBy: { createdAt: 'desc' } });
  };
  const pay = async (requestId: string) => {
    const event = stripe.pay(stripe.sessionFor(requestId)!.id);
    expect((await stripe.deliver(ctx, event)).status).toBe(200);
    await ctx.app.get(PaymentEventsProcessor).process((await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(event.id) } })).id);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    number = await seedNumber(ctx);
    tagId = (await ctx.prisma.tag.create({ data: { name: uniq('ordered-') } })).id;
    const endpoint = await admin.agent
      .post('/api/webhook-endpoints')
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: uniq('Orders hook '), url: `https://${uniq('orders')}.example.test/hooks`, eventTypes: ['chat_order.received', 'chat_order.paid'] });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    ctx.app.get(OutboundEvents).invalidate();
  });

  beforeEach(async () => {
    nock.cleanAll();
    await clearCommerce(ctx);
    stripe = new FakeStripe().install();
    await seedGateway(ctx);
    await seedCatalog(ctx, { count: 5, outOfStock: ['shp-105'] });
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('automatic mode: the cart becomes an order and its link is sent at once; paying marks it paid with the tag and events', async () => {
    await seedPaymentSettings(ctx, { chatOrderMode: 'AUTO', chatOrderTagId: tagId });
    const phone = uaePhone();
    const order = await cart(phone, [{ retailerId: 'shp-101', quantity: 2, price: 51 }, { retailerId: 'shp-102', quantity: 1, price: 52 }], 'After 6pm please');
    expect(order).toMatchObject({ status: 'LINK_SENT', mode: 'AUTO', currency: 'aed', totalMinor: 15400n, customerText: 'After 6pm please', catalogId: FAKE_CATALOG_ID });
    expect(order.items).toEqual([
      { retailerId: 'shp-101', name: 'Product 101', quantity: 2, itemPriceMinor: 5100, currency: 'aed' },
      { retailerId: 'shp-102', name: 'Product 102', quantity: 1, itemPriceMinor: 5200, currency: 'aed' },
    ]);
    const request = await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { chatOrderId: order.id } });
    expect(request).toMatchObject({ source: 'CHAT_ORDER', status: 'WAITING', amountMinor: 15400n, tagId });
    const pays = await ctx.prisma.chatMessage.count({ where: { conversationId: order.conversationId!, contentType: 'PAYMENT_REQUEST' } });
    expect(pays).toBe(1);
    const item = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: order.chatItemId! } });
    expect(item).toMatchObject({ contentType: 'ORDER' });
    expect((item.payload as Json).chatOrderId).toBe(order.id);
    expect(await ctx.prisma.conversationEvent.count({ where: { conversationId: order.conversationId!, type: 'CHAT_ORDER_RECEIVED' } })).toBe(1);
    expect(await ctx.prisma.outboundEvent.count({ where: { type: 'chat_order.received' } })).toBeGreaterThan(0);

    await pay(request.id);
    expect((await ctx.prisma.chatOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
    expect(await ctx.prisma.contactTag.count({ where: { tagId, contact: { phoneE164: phone } } })).toBe(1);
    expect(await ctx.prisma.outboundEvent.count({ where: { type: 'chat_order.paid' } })).toBeGreaterThan(0);
    const detail = await api('get', `/chat-orders/${order.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body).toMatchObject({ id: order.id, status: 'PAID', paymentRequestId: request.id, totalMinor: 15400 });

    // A full refund is mirrored.
    const refund = stripe.refund(stripe.sessionFor(request.id)!.id, 15400);
    await stripe.deliver(ctx, refund);
    await ctx.app.get(PaymentEventsProcessor).process((await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(refund.id) } })).id);
    expect((await ctx.prisma.chatOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('REFUNDED');
  });

  it('review mode: the order waits; edit, send the link, and cancel (which cancels the request)', async () => {
    await seedPaymentSettings(ctx, { chatOrderMode: 'REVIEW' });
    const order = await cart(uaePhone(), [{ retailerId: 'shp-101', quantity: 2, price: 51 }, { retailerId: 'shp-103', quantity: 1, price: 53 }]);
    expect(order.status).toBe('RECEIVED');
    expect(await ctx.prisma.paymentRequest.count({ where: { chatOrderId: order.id } })).toBe(0);

    const edited = await api('patch', `/chat-orders/${order.id}`, { items: [{ retailerId: 'shp-101', quantity: 1 }] });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    expect(edited.body).toMatchObject({ totalMinor: 5100, items: [{ retailerId: 'shp-101', quantity: 1 }] });
    expect((await api('patch', `/chat-orders/${order.id}`, { items: [{ retailerId: 'shp-999', quantity: 1 }] })).status).toBe(422);

    const sent = await api('post', `/chat-orders/${order.id}/send-link`, { expiresInMinutes: 120 });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);
    expect(sent.body).toMatchObject({ status: 'LINK_SENT' });
    expect((await api('patch', `/chat-orders/${order.id}`, { items: [{ retailerId: 'shp-101', quantity: 3 }] })).status).toBe(409);
    expect((await api('post', `/chat-orders/${order.id}/send-link`)).status).toBe(409);

    const cancelled = await api('post', `/chat-orders/${order.id}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    expect((await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { chatOrderId: order.id } })).status).toBe('CANCELLED');
    expect((await api('post', `/chat-orders/${order.id}/cancel`)).status).toBe(409);
    expect((await api('get', '/chat-orders?status=CANCELLED')).body.items.map((o: { id: string }) => o.id)).toContain(order.id);
  });

  it('warnings stop the automatic link: changed price, not in the catalog, another currency', async () => {
    await seedPaymentSettings(ctx, { chatOrderMode: 'AUTO' });
    const changed = await cart(uaePhone(), [{ retailerId: 'shp-101', quantity: 1, price: 99 }]);
    expect(changed.status).toBe('RECEIVED');
    expect(changed.warnings).toEqual([expect.objectContaining({ kind: 'PRICE_CHANGED', retailerId: 'shp-101' })]);

    const unknown = await cart(uaePhone(), [{ retailerId: 'shp-999', quantity: 1, price: 10 }]);
    expect(unknown.warnings).toEqual([expect.objectContaining({ kind: 'NOT_IN_CATALOG', retailerId: 'shp-999' })]);

    const phone = uaePhone();
    await deliver(
      webhook.inbound(number.phoneNumberId, phone.slice(1), '', {
        type: 'order',
        order: { catalog_id: FAKE_CATALOG_ID, product_items: [{ product_retailer_id: 'shp-101', quantity: 1, item_price: 14, currency: 'USD' }, { product_retailer_id: 'shp-102', quantity: 1, item_price: 52, currency: 'AED' }] },
      }),
    );
    const mixed = await ctx.prisma.chatOrder.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
    expect((mixed.warnings as Array<{ kind: string }>).map((w) => w.kind).sort()).toEqual(['CURRENCY', 'MIXED_CURRENCY']);
    expect(await ctx.prisma.paymentRequest.count({ where: { chatOrderId: { in: [changed.id, unknown.id, mixed.id] } } })).toBe(0);
    // An agent can still send the link of a cart in the account's currency.
    expect((await api('post', `/chat-orders/${changed.id}/send-link`)).status).toBe(201);
    expect((await api('post', `/chat-orders/${mixed.id}/send-link`)).status).toBe(422);
  });

  it('the contact history lists chat orders', async () => {
    await seedPaymentSettings(ctx, { chatOrderMode: 'REVIEW' });
    const phone = uaePhone();
    const order = await cart(phone, [{ retailerId: 'shp-102', quantity: 1, price: 52 }]);
    const res = await api('get', `/contacts/${order.contactId}/payments`);
    expect(res.status).toBe(200);
    expect(res.body.chatOrders).toEqual([expect.objectContaining({ id: order.id, status: 'RECEIVED', totalMinor: 5200 })]);
  });
});
