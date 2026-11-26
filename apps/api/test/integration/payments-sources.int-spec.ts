import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PaymentEventsProcessor } from '../../src/modules/payments/events/payment-events.processor.js';
import { PaymentsTickProcessor } from '../../src/modules/payments/tick/payments-tick.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { clearCommerce, seedGateway, seedPaymentSettings } from '../support/commerce.js';
import { FakeStripe } from '../support/fake-stripe.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T046 (feature 008 US3, FR-010, FR-013, FR-038, research R13): payment requests without an agent.
// A flow's payment step asks, waits, and takes the paid branch when paid or the not-paid branch when
// the request expires; test sessions are driven without paying; a paid request adds its tag and starts
// its flow by the chat-link rule. Campaigns give every recipient their own request at launch (no Stripe
// call until the link is opened); store order pay links are in payments-store-orders.int-spec.ts.

type Json = Record<string, unknown>;
const PHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

describe('Payment requests from flows (008 US3)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let admin: SignedInAgent;
  let stripe: FakeStripe;
  const suffix = uniq('');

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const flow = async (name: string, graph: object) => {
    const id = (await api(manager, 'post', '/flows', { name: `${name} ${suffix}` })).body.id as string;
    expect((await api(manager, 'put', `/flows/${id}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    const published = await api(manager, 'post', `/flows/${id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    return id;
  };
  const say = async (phoneNumberId: string, phone: string, text: string) => {
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(phoneNumberId, phone.slice(1), text)));
  };
  const textsTo = async (phone: string) => {
    const items = await ctx.prisma.chatMessage.findMany({ where: { conversation: { contact: { phoneE164: phone } }, kind: 'SESSION_OUT' }, orderBy: { occurredAt: 'asc' }, select: { text: true, contentType: true } });
    return items.map((i) => `${i.contentType}:${i.text ?? ''}`);
  };
  const deliver = async (event: Json) => {
    expect((await stripe.deliver(ctx, event)).status).toBe(200);
    const row = await ctx.prisma.paymentEvent.findFirstOrThrow({ where: { stripeEventId: String(event.id) } });
    await ctx.app.get(PaymentEventsProcessor).process(row.id);
  };
  const graph = (keyword: string, extra: Json = {}) => ({
    version: 1,
    start: 'pay',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
    steps: [
      { id: 'pay', type: 'payment', amount: { source: 'static', minor: 9900 }, description: 'Booking fee', expiryMinutes: 60, next: 'thanks', onNotPaid: 'sorry', ...extra },
      { id: 'thanks', type: 'message', text: 'Paid, see you on Friday' },
      { id: 'sorry', type: 'message', text: 'The payment link expired' },
    ],
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    admin = await signIn(ctx, 'ADMIN');
  });

  beforeEach(async () => {
    nock.cleanAll();
    await clearCommerce(ctx);
    stripe = new FakeStripe().install();
    await seedGateway(ctx);
    await seedPaymentSettings(ctx);
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('refuses to publish a payment step while Stripe is not connected', async () => {
    await ctx.prisma.paymentGateway.deleteMany();
    const id = (await api(manager, 'post', '/flows', { name: `No gateway ${suffix}` })).body.id as string;
    await api(manager, 'put', `/flows/${id}/draft`, { graph: graph(`nogw${suffix}`), draftRevision: 0 });
    const res = await api(manager, 'post', `/flows/${id}/publish`);
    expect(res.status).not.toBe(200);
    expect(JSON.stringify(res.body)).toContain('PAYMENTS_NOT_CONNECTED');
  });

  it('asks for the payment, waits, and takes the paid branch', async () => {
    const number = await seedNumber(ctx);
    const phone = uaePhone();
    await flow('Pay booking', graph(`book${suffix}`));
    await say(number.phoneNumberId, phone, `book${suffix}`);
    const request = await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { phoneE164: phone } });
    expect(request).toMatchObject({ source: 'FLOW', status: 'WAITING', amountMinor: 9900n, description: 'Booking fee' });
    expect(request.flowSessionId).toBeTruthy();
    expect(await textsTo(phone)).toEqual([expect.stringMatching(/^PAYMENT_REQUEST:Booking fee/)]);
    const session = await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: request.flowSessionId as string } });
    expect(session.wait).toBe('PAYMENT');

    await deliver(stripe.pay(stripe.sessionFor(request.id)!.id));
    expect((await textsTo(phone)).at(-1)).toBe('TEXT:Paid, see you on Friday');
  });

  it('takes the not-paid branch when the request expires', async () => {
    const number = await seedNumber(ctx);
    const phone = uaePhone();
    await flow('Pay expiry', graph(`late${suffix}`, { expiryMinutes: 30 }));
    await say(number.phoneNumberId, phone, `late${suffix}`);
    await ctx.app.get(PaymentsTickProcessor).runTick(new Date(Date.now() + 31 * 60_000));
    expect((await textsTo(phone)).at(-1)).toBe('TEXT:The payment link expired');
  });

  it('continues on the not-paid branch at once when Stripe is down', async () => {
    const number = await seedNumber(ctx);
    const phone = uaePhone();
    stripe.fail('POST', /^\/v1\/checkout\/sessions$/, 503, undefined, 4);
    await flow('Pay outage', graph(`down${suffix}`));
    await say(number.phoneNumberId, phone, `down${suffix}`);
    expect(await ctx.prisma.paymentRequest.count({ where: { phoneE164: phone } })).toBe(0);
    expect((await textsTo(phone)).at(-1)).toBe('TEXT:The payment link expired');
  });

  it('drives a test session’s payment step without paying', async () => {
    const number = await seedNumber(ctx);
    const phone = uaePhone();
    const flowId = await flow('Pay test', graph(`trial${suffix}`));
    const contact = await ctx.prisma.contact.create({ data: { phoneE164: phone, countryCode: 'AE', name: 'Tester', consentStatus: 'OPTED_IN', consentSource: 'MANUAL' } });
    const conversation = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id, lastCustomerMessageAt: new Date(), lastInboundAt: new Date() } });
    const { FlowSessionService } = await import('../../src/modules/flows/engine/session.service.js');
    const version = await ctx.prisma.flow.findUniqueOrThrow({ where: { id: flowId }, select: { publishedVersionId: true } });
    await ctx.app.get(FlowSessionService).start({ flowId, versionId: version.publishedVersionId, conversationId: conversation.id, startedBy: 'MEMBER', isTest: true });
    const request = await ctx.prisma.paymentRequest.findFirstOrThrow({ where: { conversationId: conversation.id } });
    expect(request.isTest).toBe(true);
    const res = await api(manager, 'post', `/payments/requests/${request.id}/test-result`, { result: 'paid' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await textsTo(phone)).at(-1)).toBe('TEXT:Paid, see you on Friday');
    const again = await api(manager, 'post', `/payments/requests/${request.id}/test-result`, { result: 'notPaid' });
    expect(again.status).toBe(409);
  });

  it('gives each campaign recipient their own request at launch, holds back missing amounts, and makes sessions only when opened', async () => {
    const base = process.env.PUBLIC_LINK_BASE_URL as string;
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, {
      components: [
        { type: 'BODY', text: 'Hi {{1}}, your invoice is {{2}}.', example: { body_text: [['Sara', 'AED 99.00']] } },
        { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pay now', url: `${base}/p/{{1}}`, example: [`${base}/p/AbCdEf1234`] }] },
      ],
      variables: [
        { key: 'BODY.1', example: 'Sara' },
        { key: 'BODY.2', example: 'AED 99.00' },
        { key: 'BUTTON.0.1', example: 'AbCdEf1234' },
      ],
    });
    const tagName = `payc-${suffix}`;
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    const people = [
      { name: 'Amna', balance: 120.5 },
      { name: 'Bilal', balance: '80' },
      { name: 'Chen', balance: 'soon' },
      { name: 'Dana', balance: undefined },
    ];
    const contacts = [];
    for (const p of people) {
      const contact = await seedContact(ctx, uaePhone(), { name: p.name, attributes: p.balance === undefined ? {} : { balance: p.balance } });
      await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
      contacts.push(contact);
    }
    const draft = await api(manager, 'post', '/campaigns', {
      name: `Invoices ${suffix}`,
      numberId: number.id,
      templateId: template.id,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag: tagName }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' }, 'BODY.2': { source: 'payment', key: 'amount' } },
      paymentConfig: { amount: { source: 'attribute', attributeKey: 'balance' }, description: 'Invoice for {name}', expiryMinutes: 1440 },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body.paymentConfig).toMatchObject({ amount: { source: 'attribute', attributeKey: 'balance' } });
    const estimate = await api(manager, 'post', `/campaigns/${draft.body.id}/estimate`);
    expect(estimate.status, JSON.stringify(estimate.body)).toBe(200);
    expect(estimate.body.excluded).toMatchObject({ paymentAmountMissing: 2 });
    const launched = await api(manager, 'post', `/campaigns/${draft.body.id}/launch`, {});
    expect(launched.status, JSON.stringify(launched.body)).toBe(200);

    const messages = await ctx.prisma.message.findMany({ where: { campaignId: draft.body.id }, include: { contact: { select: { name: true } } } });
    const requests = await ctx.prisma.paymentRequest.findMany({ where: { campaignId: draft.body.id } });
    expect(requests).toHaveLength(2);
    expect(messages.filter((m) => m.skipReason === 'PAYMENT_AMOUNT_MISSING').map((m) => m.contact?.name).sort()).toEqual(['Chen', 'Dana']);
    for (const r of requests) {
      const message = messages.find((m) => m.id === r.messageId);
      expect(message, 'each request belongs to its recipient’s message').toBeDefined();
      expect(message!.contactId).toBe(r.contactId);
      const params = message!.resolvedParams as Record<string, string>;
      expect(params['BUTTON.0.1']).toBe(r.code);
      expect(params['BODY.2']).toMatch(/120\.50|80\.00/);
      expect(r).toMatchObject({ source: 'CAMPAIGN', status: 'WAITING', sessionId: null, currency: 'aed' });
      expect(r.description).toBe(`Invoice for ${message!.contact?.name}`);
    }
    expect(requests.map((r) => Number(r.amountMinor)).sort((a, b) => a - b)).toEqual([8000, 12050]);
    expect(stripe.callsTo('POST', /^\/v1\/checkout\/sessions$/)).toHaveLength(0);

    // The first open makes the Checkout Session and sends the customer there.
    const first = requests[0]!;
    const opened = await request(ctx.server()).get(`/l/p/${first.code}`).set('user-agent', PHONE_UA);
    expect(opened.status).toBe(302);
    expect(opened.headers.location).toBe(stripe.sessionFor(first.id)?.url);
    expect(stripe.callsTo('POST', /^\/v1\/checkout\/sessions$/)).toHaveLength(1);
  });

  it('refuses to launch a payment campaign whose template has no pay link button', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const tagName = `paynb-${suffix}`;
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    const contact = await seedContact(ctx, uaePhone());
    await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
    const draft = await api(manager, 'post', '/campaigns', {
      name: `No button ${suffix}`,
      numberId: number.id,
      templateId: template.id,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag: tagName }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
      paymentConfig: { amount: { source: 'static', minor: 5000 }, description: 'Deposit', expiryMinutes: 600 },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const launched = await api(manager, 'post', `/campaigns/${draft.body.id}/launch`, {});
    expect(launched.status).toBe(422);
    expect(launched.body.code).toBe('TEMPLATE_NOT_PAY_LINK');
  });

  it('adds the paid request’s tag and starts its flow, but never in a chat a member has taken', async () => {
    const number = await seedNumber(ctx);
    const phone = uaePhone();
    const tag = await ctx.prisma.tag.create({ data: { name: `paid-${suffix}` } });
    const welcome = await flow('After payment', { version: 1, start: 'hi', triggers: [], steps: [{ id: 'hi', type: 'message', text: 'Welcome aboard' }] });
    await say(number.phoneNumberId, phone, 'hello there');
    const conversation = await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
    const made = await api(admin, 'post', `/inbox/conversations/${conversation.id}/payment-requests`, { amountMinor: 5000, description: 'Deposit', tagId: tag.id, flowId: welcome });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    // The admin's request took the chat, so the flow does not start; the tag is still added.
    await deliver(stripe.pay(stripe.sessionFor(String(made.body.id))!.id));
    expect(await ctx.prisma.contactTag.count({ where: { tagId: tag.id, contact: { phoneE164: phone } } })).toBe(1);
    expect((await textsTo(phone)).some((t) => t.includes('Welcome aboard'))).toBe(false);

    // In a chat nobody has taken (an API request), the flow starts.
    const other = uaePhone();
    await say(number.phoneNumberId, other, 'hi again');
    const otherChat = await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: other } } });
    const { PaymentRequestsService } = await import('../../src/modules/payments/requests/payment-requests.service.js');
    const { PaymentGatewayService } = await import('../../src/modules/payments/gateway/payment-gateway.service.js');
    const { PaymentSettingsService } = await import('../../src/modules/payments/settings/payment-settings.service.js');
    const row = await ctx.app.get(PaymentRequestsService).create({
      access: await ctx.app.get(PaymentGatewayService).requireReady(),
      settings: await ctx.app.get(PaymentSettingsService).row(),
      source: 'API',
      amountMinor: 5000,
      description: 'Deposit',
      expiresInMinutes: 60,
      contactId: otherChat.contactId,
      conversationId: otherChat.id,
      flowId: welcome,
    });
    await deliver(stripe.pay(stripe.sessionFor(row.id)!.id));
    expect((await textsTo(other)).at(-1)).toBe('TEXT:Welcome aboard');
  });
});
