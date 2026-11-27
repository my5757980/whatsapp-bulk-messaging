import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { clearCommerce, formReply, orderMessage, seedCatalog, seedGateway, seedPaymentSettings } from '../support/commerce.js';
import { FakeCommerceGraph } from '../support/fake-commerce-graph.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, seedNumber, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T087 (feature 008 US8, FR-036 – FR-041): a flow sends a product list, the cart goes to the flow (chat
// order mode FLOW, no automatic link), the payment step charges the cart total and takes the paid
// branch; a form step's answers are used in a later message; publishing needs the catalog and the form.

type Json = Record<string, unknown>;

describe('Commerce steps in flows (008 US8)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let stripe: FakeStripe;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  const suffix = uniq('').slice(-6).toLowerCase().replace(/[^a-z0-9]/g, 'x');

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const flow = async (name: string, graph: object) => {
    const id = (await api('post', '/flows', { name: `${name} ${suffix}` })).body.id as string;
    expect((await api('put', `/flows/${id}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    return { id, publish: () => api('post', `/flows/${id}/publish`) };
  };
  const deliver = async (body: Json) => ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, body));
  const say = (phone: string, text: string) => deliver(webhook.inbound(number.phoneNumberId, phone.slice(1), text));
  const sent = async (phone: string) =>
    (await ctx.prisma.chatMessage.findMany({ where: { conversation: { contact: { phoneE164: phone } }, kind: 'SESSION_OUT' }, orderBy: { occurredAt: 'asc' }, select: { contentType: true, text: true, payload: true } })).map((i) => ({ ...i, payload: i.payload as Json }));

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
  });

  beforeEach(async () => {
    nock.cleanAll();
    await clearCommerce(ctx);
    stripe = new FakeStripe().install();
    new FakeCommerceGraph(0).install();
    await seedGateway(ctx);
    await seedPaymentSettings(ctx, { chatOrderMode: 'AUTO' });
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('sends a product list, takes the cart into the flow and charges its total', async () => {
    await seedCatalog(ctx, { count: 5 });
    const shop = await flow('Shop', {
      version: 1,
      start: 'list',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`shop${suffix}`], canInterrupt: false }],
      steps: [
        { id: 'list', type: 'product', header: 'New in', body: 'Pick what you like', sections: [{ title: '', retailerIds: ['shp-101', 'shp-102'] }], timeoutMinutes: 30, next: 'pay', onTimeout: null },
        { id: 'pay', type: 'payment', amount: { source: 'cartTotal' }, description: 'Your order', expiryMinutes: 120, next: 'thanks', onNotPaid: null },
        { id: 'thanks', type: 'message', text: 'Paid {answer:cart_total}, thank you' },
      ],
    });
    const published = await shop.publish();
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const phone = uaePhone();
    await say(phone, `shop${suffix}`);
    expect((await sent(phone)).map((i) => i.contentType)).toEqual(['PRODUCT_LIST']);

    await deliver(orderMessage(number.phoneNumberId, phone.slice(1), [{ retailerId: 'shp-101', quantity: 2, price: 51 }, { retailerId: 'shp-102', quantity: 1, price: 52 }]));
    const order = await ctx.prisma.chatOrder.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
    expect(order).toMatchObject({ mode: 'FLOW', totalMinor: 15400n });
    const request = await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { chatOrderId: order.id } });
    expect(request).toMatchObject({ source: 'FLOW', amountMinor: 15400n });
    expect(await ctx.prisma.paymentRequest.count({ where: { chatOrderId: order.id } })).toBe(1);

    const event = stripe.pay(stripe.sessionFor(request.id)!.id);
    await stripe.deliver(ctx, event);
    await ctx.app.get(PaymentEventsProcessor).process((await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(event.id) } })).id);
    expect((await sent(phone)).at(-1)).toMatchObject({ contentType: 'TEXT', text: 'Paid 154.00, thank you' });
    expect((await ctx.prisma.chatOrder.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('PAID');
  });

  it("uses a form step's answers in a later message", async () => {
    const formId = (await api('post', '/forms', { name: `Lead ${suffix}`, category: 'LEAD_GENERATION' })).body.id as string;
    await api('put', `/forms/${formId}`, { name: `Lead ${suffix}`, category: 'LEAD_GENERATION', draft: { screens: [{ title: 'You', button: 'Submit', fields: [{ key: 'name', type: 'shortText', label: 'Name', required: true }] }] }, mapping: [], tagIds: [] });
    expect((await api('post', `/forms/${formId}/publish`)).status).toBe(201);
    const ask = await flow('Ask', {
      version: 1,
      start: 'ask',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`lead${suffix}`], canInterrupt: false }],
      steps: [
        { id: 'ask', type: 'form', formId, body: 'Tell us about you', cta: 'Open', answerPrefix: 'lead', timeoutMinutes: 60, next: 'hello', onTimeout: null },
        { id: 'hello', type: 'message', text: 'Hello {answer:lead_name}' },
      ],
    });
    expect((await ask.publish()).status).toBe(200);
    const phone = uaePhone();
    await say(phone, `lead${suffix}`);
    const formItem = (await sent(phone)).find((i) => i.contentType === 'FORM');
    expect(formItem?.payload.token).toMatch(/^wf1\./);
    await deliver(formReply(number.phoneNumberId, phone.slice(1), { flow_token: formItem!.payload.token, name: 'Sara' }));
    expect((await sent(phone)).at(-1)).toMatchObject({ contentType: 'TEXT', text: 'Hello Sara' });
    expect(await ctx.prisma.formAnswer.count({ where: { formId, source: 'FLOW' } })).toBe(1);
  });

  it('refuses to publish without the catalog or with a form that is not published', async () => {
    const noCatalog = await flow('No catalog', {
      version: 1,
      start: 'cat',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`cat${suffix}`], canInterrupt: false }],
      steps: [{ id: 'cat', type: 'catalog', body: 'Browse', thumbnailRetailerId: null, timeoutMinutes: 60, next: 'end', onTimeout: null }, { id: 'end', type: 'end' }],
    });
    expect(JSON.stringify((await noCatalog.publish()).body)).toContain('CATALOG_NOT_CONNECTED');
    const draftForm = (await api('post', '/forms', { name: `Draft ${suffix}`, category: 'OTHER' })).body.id as string;
    const unpublished = await flow('Draft form', {
      version: 1,
      start: 'ask',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`draft${suffix}`], canInterrupt: false }],
      steps: [{ id: 'ask', type: 'form', formId: draftForm, body: 'Hi', cta: 'Open', answerPrefix: 'form', timeoutMinutes: 60, next: 'end', onTimeout: null }, { id: 'end', type: 'end' }],
    });
    expect(JSON.stringify((await unpublished.publish()).body)).toContain('FORM_NOT_PUBLISHED');
  });
});
