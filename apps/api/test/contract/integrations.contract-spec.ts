import { createHmac, randomUUID } from 'node:crypto';
import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { WebhookDeliveryProcessor } from '../../src/modules/integrations/webhooks/webhook-delivery.processor.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// 006 contract tests (T019 and later stories): responses match contracts/integrations-api.openapi.yaml.
describe('Integrations API contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('integrations-api.openapi.yaml', method, route, res.status, res.body);
  };
  const call = (method: 'get' | 'post' | 'put' | 'patch' | 'delete', url: string, body?: object) => {
    const req = admin.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', admin.csrf).send(body ?? {});
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('US1: webhook endpoints, the test event, the delivery log and resend', async () => {
    const host = `https://${uniq('contract')}.example.test`;
    await check('get', '/webhook-event-types', await call('get', '/webhook-event-types'), 200);

    const created = await call('post', '/webhook-endpoints', { name: uniq('Contract '), url: `${host}/hooks`, eventTypes: ['contact.opted_out'], includeContent: true });
    await check('post', '/webhook-endpoints', created, 201);
    await check('post', '/webhook-endpoints', await call('post', '/webhook-endpoints', { name: uniq('Bad '), url: 'http://plain.example.test', eventTypes: ['contact.opted_out'] }), 422);
    const id = created.body.id as string;
    const missing = randomUUID();

    await check('get', '/webhook-endpoints', await call('get', '/webhook-endpoints'), 200);
    await check('get', '/webhook-endpoints/{id}', await call('get', `/webhook-endpoints/${id}`), 200);
    await check('get', '/webhook-endpoints/{id}', await call('get', `/webhook-endpoints/${missing}`), 404);
    await check('patch', '/webhook-endpoints/{id}', await call('patch', `/webhook-endpoints/${id}`, { eventTypes: ['contact.opted_out', 'contact.opted_in'] }), 200);
    await check('patch', '/webhook-endpoints/{id}', await call('patch', `/webhook-endpoints/${id}`, { url: 'https://10.0.0.8/x' }), 422);
    await check('patch', '/webhook-endpoints/{id}', await call('patch', `/webhook-endpoints/${missing}`, { name: 'x' }), 404);
    await check('post', '/webhook-endpoints/{id}/pause', await call('post', `/webhook-endpoints/${id}/pause`), 200);
    await check('post', '/webhook-endpoints/{id}/pause', await call('post', `/webhook-endpoints/${missing}/pause`), 404);
    await check('post', '/webhook-endpoints/{id}/resume', await call('post', `/webhook-endpoints/${id}/resume`), 200);
    await check('post', '/webhook-endpoints/{id}/renew-secret', await call('post', `/webhook-endpoints/${id}/renew-secret`), 200);

    nock(host).post('/hooks').reply(200, 'ok');
    await check('post', '/webhook-endpoints/{id}/test', await call('post', `/webhook-endpoints/${id}/test`), 200);
    await check('post', '/webhook-endpoints/{id}/test', await call('post', `/webhook-endpoints/${missing}/test`), 404);

    const contact = await seedContact(ctx, uaePhone());
    const [deliveryId] = await ctx.app.get(OutboundEvents).record(ctx.prisma, 'contact.opted_out', { contact: { id: contact.id, phone: contact.phoneE164, name: null }, source: 'MANUAL' });
    nock(host).post('/hooks').reply(200, 'ok');
    await ctx.app.get(WebhookDeliveryProcessor).deliver(deliveryId!);
    await check('get', '/webhook-endpoints/{id}/deliveries', await call('get', `/webhook-endpoints/${id}/deliveries?page=1&pageSize=20`), 200);
    await check('get', '/webhook-endpoints/{id}/deliveries', await call('get', `/webhook-endpoints/${missing}/deliveries`), 404);
    await check('post', '/webhook-deliveries/{id}/resend', await call('post', `/webhook-deliveries/${deliveryId}/resend`), 202);
    await check('post', '/webhook-deliveries/{id}/resend', await call('post', `/webhook-deliveries/${missing}/resend`), 404);

    await check('delete', '/webhook-endpoints/{id}', await call('delete', `/webhook-endpoints/${id}`), 204);
    await check('delete', '/webhook-endpoints/{id}', await call('delete', `/webhook-endpoints/${missing}`), 404);
  });

  it('US3: API campaigns from draft to live, paused, results, export and stopped', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { components: [{ type: 'BODY', text: 'Order {{1}} is ready' }], variables: [{ key: 'BODY.1', example: 'A-1' }] });
    const missing = randomUUID();
    const input = { name: uniq('Contract campaign '), apiName: uniq('contract-'), numberId: number.id, templateId: template.id, tags: ['contract'] };
    const created = await call('post', '/api-campaigns', input);
    await check('post', '/api-campaigns', created, 201);
    await check('post', '/api-campaigns', await call('post', '/api-campaigns', input), 409);
    await check('post', '/api-campaigns', await call('post', '/api-campaigns', { ...input, name: uniq('Other '), apiName: 'Not Valid' }), 422);
    const id = created.body.id as string;
    await check('get', '/api-campaigns', await call('get', '/api-campaigns'), 200);
    await check('get', '/api-campaigns/{id}', await call('get', `/api-campaigns/${id}`), 200);
    await check('get', '/api-campaigns/{id}', await call('get', `/api-campaigns/${missing}`), 404);
    await check('post', '/api-campaigns/{id}/go-live', await call('post', `/api-campaigns/${id}/go-live`), 409);
    await check('post', '/api-campaigns/{id}/go-live', await call('post', `/api-campaigns/${missing}/go-live`), 404);
    await check('patch', '/api-campaigns/{id}', await call('patch', `/api-campaigns/${id}`, { variableMapping: { 'BODY.1': { source: 'value', key: 'order' } } }), 200);
    await check('patch', '/api-campaigns/{id}', await call('patch', `/api-campaigns/${id}`, { dailyLimit: 0 }), 422);
    await check('patch', '/api-campaigns/{id}', await call('patch', `/api-campaigns/${missing}`, { dailyLimit: 5 }), 404);
    await check('post', '/api-campaigns/{id}/go-live', await call('post', `/api-campaigns/${id}/go-live`), 200);
    await check('patch', '/api-campaigns/{id}', await call('patch', `/api-campaigns/${id}`, { apiName: uniq('renamed-') }), 409);
    await check('post', '/api-campaigns/{id}/pause', await call('post', `/api-campaigns/${id}/pause`), 200);
    await check('post', '/api-campaigns/{id}/pause', await call('post', `/api-campaigns/${id}/pause`), 409);
    await check('post', '/api-campaigns/{id}/pause', await call('post', `/api-campaigns/${missing}/pause`), 404);
    await check('get', '/api-campaigns/{id}/results', await call('get', `/api-campaigns/${id}/results`), 200);
    await check('get', '/api-campaigns/{id}/results', await call('get', `/api-campaigns/${missing}/results`), 404);
    await check('get', '/api-campaigns/{id}/export', await call('get', `/api-campaigns/${id}/export`), 200);
    await check('get', '/api-campaigns/{id}/export', await call('get', `/api-campaigns/${missing}/export`), 404);
    await check('post', '/api-campaigns/{id}/stop', await call('post', `/api-campaigns/${id}/stop`), 200);
    await check('post', '/api-campaigns/{id}/stop', await call('post', `/api-campaigns/${missing}/stop`), 404);
    await check('patch', '/api-campaigns/{id}', await call('patch', `/api-campaigns/${id}`, { dailyLimit: 5 }), 409);
  });

  it('US4: stores, automations, results, orders, sync, disconnect and both receivers', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { components: [{ type: 'BODY', text: 'Order {{1}} confirmed' }], variables: [{ key: 'BODY.1', example: '1001' }] });
    const missing = randomUUID();
    const key = { consumerKey: 'ck_contract_0123456789', consumerSecret: 'cs_contract_0123456789' };
    const site = `https://${uniq('woo-contract-')}.example.test`;
    const hooks: Array<{ id: number; secret: string }> = [];
    nock(site).persist().get('/wp-json/').reply(200, { name: 'Contract Woo' });
    nock(site).persist().get('/wp-json/wc/v3/orders').query(true).reply(200, []);
    nock(site).persist().get('/wp-json/wc/v3/webhooks').query(true).reply(200, []);
    nock(site)
      .persist()
      .post('/wp-json/wc/v3/webhooks')
      .reply(async (request: Request) => {
        const b = (await request.json()) as { secret: string };
        hooks.push({ id: hooks.length + 1, secret: b.secret });
        return [201, { id: hooks.length, status: 'active' }];
      });
    nock(site).persist().delete(/\/wp-json\/wc\/v3\/webhooks\/\d+/).query(true).reply(200, {});
    const input = { platform: 'WOOCOMMERCE', baseUrl: site, numberId: number.id, defaultCountry: 'AE', customerTag: 'woo', credentials: key };
    const created = await call('post', '/stores', input);
    await check('post', '/stores', created, 201);
    await check('post', '/stores', await call('post', '/stores', input), 409);
    await check('post', '/stores', await call('post', '/stores', { ...input, baseUrl: 'http://not-https.example.test' }), 422);
    const id = created.body.id as string;
    await check('get', '/stores', await call('get', '/stores'), 200);
    await check('get', '/stores/{id}', await call('get', `/stores/${id}`), 200);
    await check('get', '/stores/{id}', await call('get', `/stores/${missing}`), 404);
    await check('patch', '/stores/{id}', await call('patch', `/stores/${id}`, { customerTag: 'woo-buyers', consentIsWhatsapp: true }), 200);
    await check('patch', '/stores/{id}', await call('patch', `/stores/${id}`, { defaultCountry: 'uae' }), 422);
    await check('patch', '/stores/{id}', await call('patch', `/stores/${missing}`, { customerTag: 'x' }), 404);

    const automation = { enabled: true, steps: [{ templateId: template.id, variableMapping: { 'BODY.1': { source: 'order', key: 'order_number' } } }] };
    await check('put', '/stores/{id}/automations/{kind}', await call('put', `/stores/${id}/automations/ORDER_CONFIRMED`, automation), 200);
    await check('put', '/stores/{id}/automations/{kind}', await call('put', `/stores/${id}/automations/ORDER_CONFIRMED`, { enabled: true, steps: [] }), 422);
    await check('put', '/stores/{id}/automations/{kind}', await call('put', `/stores/${missing}/automations/ORDER_CONFIRMED`, automation), 404);
    await check('get', '/stores/{id}/automations/{kind}', await call('get', `/stores/${id}/automations/ORDER_CONFIRMED`), 200);
    await check('get', '/stores/{id}/automations/{kind}', await call('get', `/stores/${missing}/automations/ORDER_CONFIRMED`), 404);

    const order = JSON.stringify({ id: 990, number: '990', status: 'processing', currency: 'AED', total: '10.00', payment_method: 'bacs', date_created_gmt: new Date().toISOString().slice(0, 19), date_modified_gmt: new Date().toISOString().slice(0, 19), billing: { phone: uaePhone() }, shipping: {}, line_items: [], meta_data: [] });
    const woo = (signature: string) =>
      request(ctx.server())
        .post(`/api/integrations/woocommerce/${id}/webhooks`)
        .set('content-type', 'application/json')
        .set('x-wc-webhook-topic', 'order.created')
        .set('x-wc-webhook-delivery-id', randomUUID())
        .set('x-wc-webhook-signature', signature)
        .send(order);
    const wooRoute = '/integrations/woocommerce/{storeId}/webhooks';
    await check('post', wooRoute, await woo('bad'), 401);
    await check('post', wooRoute, await woo(createHmac('sha256', hooks[0]!.secret).update(order).digest('base64')), 200);
    const shopifyRoute = '/integrations/shopify/{storeId}/webhooks';
    const toShopify = request(ctx.server()).post(`/api/integrations/shopify/${id}/webhooks`).set('content-type', 'application/json').set('x-shopify-hmac-sha256', 'bad').send('{}');
    await check('post', shopifyRoute, await toShopify, 404);

    await check('get', '/stores/{id}/automations/{kind}/results', await call('get', `/stores/${id}/automations/ORDER_CONFIRMED/results`), 200);
    await check('get', '/stores/{id}/automations/{kind}/results', await call('get', `/stores/${missing}/automations/ORDER_CONFIRMED/results`), 404);
    await check('get', '/stores/{id}/orders', await call('get', `/stores/${id}/orders`), 200);
    await check('get', '/stores/{id}/orders', await call('get', `/stores/${missing}/orders`), 404);
    await check('get', '/stores/{id}/carts', await call('get', `/stores/${id}/carts?status=OPEN`), 200);
    await check('get', '/stores/{id}/carts', await call('get', `/stores/${missing}/carts`), 404);
    await check('post', '/stores/{id}/sync', await call('post', `/stores/${id}/sync`), 202);
    await check('post', '/stores/{id}/sync', await call('post', `/stores/${missing}/sync`), 404);
    await check('post', '/stores/{id}/disconnect', await call('post', `/stores/${id}/disconnect`), 200);
    await check('post', '/stores/{id}/disconnect', await call('post', `/stores/${missing}/disconnect`), 404);
    nock.cleanAll();
  });

  it('US7: chat links, the QR image, results, contacts, tagging, the export and the public redirect', async () => {
    const number = await seedNumber(ctx);
    const missing = randomUUID();
    const body = { name: uniq('Counter '), numberId: number.id, message: 'Hi, I saw your poster' };
    const created = await call('post', '/chat-links', body);
    await check('post', '/chat-links', created, 201);
    await check('post', '/chat-links', await call('post', '/chat-links', body), 409);
    await check('post', '/chat-links', await call('post', '/chat-links', { ...body, name: uniq('Counter '), message: '' }), 422);
    const id = created.body.id as string;
    const one = `/chat-links/${id}`;
    const none = `/chat-links/${missing}`;
    await check('get', '/chat-links', await call('get', '/chat-links'), 200);
    await check('get', '/chat-links/{id}', await call('get', one), 200);
    await check('get', '/chat-links/{id}', await call('get', none), 404);
    await check('patch', '/chat-links/{id}', await call('patch', one, { message: 'Hello from the counter' }), 200);
    await check('patch', '/chat-links/{id}', await call('patch', one, { status: 'PAUSED' }), 422);
    await check('patch', '/chat-links/{id}', await call('patch', none, { status: 'OFF' }), 404);
    await check('get', '/chat-links/{id}/qr', await call('get', `${one}/qr?format=svg`), 200);
    await check('get', '/chat-links/{id}/qr', await call('get', `${none}/qr`), 404);
    await check('get', '/chat-links/{id}/results', await call('get', `${one}/results`), 200);
    await check('get', '/chat-links/{id}/results', await call('get', `${none}/results`), 404);
    await check('get', '/chat-links/{id}/contacts', await call('get', `${one}/contacts`), 200);
    await check('get', '/chat-links/{id}/contacts', await call('get', `${none}/contacts`), 404);
    await check('post', '/chat-links/{id}/contacts/tag', await call('post', `${one}/contacts/tag`, { tag: 'counter' }), 200);
    await check('post', '/chat-links/{id}/contacts/tag', await call('post', `${none}/contacts/tag`, { tag: 'counter' }), 404);
    await check('get', '/chat-links/{id}/contacts/export', await call('get', `${one}/contacts/export`), 200);
    await check('get', '/chat-links/{id}/contacts/export', await call('get', `${none}/contacts/export`), 404);

    const code = String(created.body.shortUrl).split('/').pop()!;
    await check('get', '/l/c/{code}', await request(ctx.server()).get(`/l/c/${code}`), 302);
    await check('get', '/l/c/{code}', await request(ctx.server()).get('/l/c/Zz9Zz9Zz9Z'), 404);
    await check('delete', '/chat-links/{id}', await call('delete', one), 204);
    await check('delete', '/chat-links/{id}', await call('delete', one), 404);
    await check('get', '/l/c/{code}', await request(ctx.server()).get(`/l/c/${code}`), 404);
  });
});
