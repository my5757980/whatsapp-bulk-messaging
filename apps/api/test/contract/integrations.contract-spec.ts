import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { WebhookDeliveryProcessor } from '../../src/modules/integrations/webhooks/webhook-delivery.processor.js';
import { restoreNetwork, seedContact, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
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
});
