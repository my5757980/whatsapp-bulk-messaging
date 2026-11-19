import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';
import { expectMatchesContract } from './openapi-validator.js';

// T025 (and later stories): live chat responses match specs/002-team-inbox/contracts/inbox-api.openapi.yaml.
describe('Live chat API contract', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let agentA: SignedInAgent;
  let agentB: SignedInAgent;
  let number: { id: string; phoneNumberId: string; wabaId: string };

  const check = async (method: string, route: string, res: { status: number; body: unknown }, expected: number) => {
    expect(res.status, JSON.stringify(res.body)).toBe(expected);
    await expectMatchesContract('inbox-api.openapi.yaml', method, route, res.status, res.body);
  };

  /** A chat opened by a customer message; returns its ID. */
  const newChat = async (): Promise<string> => {
    const phone = uaePhone();
    const payload = webhook.inbound(number.phoneNumberId, phone.slice(1), `Hello ${randomUUID().slice(0, 4)}`);
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return (await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } })).id;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    agentA = await signIn(ctx, 'AGENT');
    agentB = await signIn(ctx, 'AGENT');
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('US1: lists, opens, takes, answers, reads and closes a chat', async () => {
    const id = await newChat();

    await check('get', '/inbox/conversations', await admin.agent.get('/api/inbox/conversations'), 200);
    await check('get', '/inbox/conversations', await agentA.agent.get('/api/inbox/conversations').query({ view: 'live', state: 'ACTIVE', mine: 'false' }), 200);
    await check('get', '/inbox/conversations', await admin.agent.get('/api/inbox/conversations').query({ view: 'live', state: 'BOGUS' }), 422);
    await check('get', '/inbox/conversations/{id}', await agentA.agent.get(`/api/inbox/conversations/${id}`), 200);
    await check('get', '/inbox/conversations/{id}', await agentA.agent.get(`/api/inbox/conversations/${randomUUID()}`), 404);
    await check('get', '/inbox/conversations/{id}/items', await agentA.agent.get(`/api/inbox/conversations/${id}/items`).query({ limit: 10 }), 200);
    await check('get', '/inbox/unread', await agentA.agent.get('/api/inbox/unread'), 200);

    await check('post', '/inbox/conversations/{id}/intervene', await agentA.agent.post(`/api/inbox/conversations/${id}/intervene`).set('X-CSRF-Token', agentA.csrf), 200);
    await check('post', '/inbox/conversations/{id}/intervene', await admin.agent.post(`/api/inbox/conversations/${id}/intervene`).set('X-CSRF-Token', admin.csrf), 409);
    await check('post', '/inbox/conversations/{id}/resolve', await agentB.agent.post(`/api/inbox/conversations/${id}/resolve`).set('X-CSRF-Token', agentB.csrf), 404);

    // Replies are only queued here; no send worker runs in contract tests.
    const reply = await agentA.agent.post(`/api/inbox/conversations/${id}/messages`).set('X-CSRF-Token', agentA.csrf).send({ type: 'text', text: 'Hi! How can we help?' });
    await check('post', '/inbox/conversations/{id}/messages', reply, 202);
    await check(
      'post',
      '/inbox/conversations/{id}/messages',
      await agentA.agent.post(`/api/inbox/conversations/${id}/messages`).set('X-CSRF-Token', agentA.csrf).send({ type: 'text', text: '' }),
      422,
    );

    const read = await agentA.agent.post(`/api/inbox/conversations/${id}/read`).set('X-CSRF-Token', agentA.csrf);
    expect(read.status).toBe(204);
    await check('post', '/inbox/conversations/{id}/read', read, 204);

    await check('post', '/inbox/conversations/{id}/resolve', await agentA.agent.post(`/api/inbox/conversations/${id}/resolve`).set('X-CSRF-Token', agentA.csrf), 200);
    await check('post', '/inbox/conversations/{id}/resolve', await agentA.agent.post(`/api/inbox/conversations/${id}/resolve`).set('X-CSRF-Token', agentA.csrf), 409);
  });

  it('US2: Past chats, starting a chat and sending a template', async () => {
    await check('get', '/inbox/conversations', await admin.agent.get('/api/inbox/conversations').query({ view: 'history' }), 200);
    await check('get', '/inbox/numbers', await agentA.agent.get('/api/inbox/numbers'), 200);

    const phone = uaePhone();
    const contact = await seedContact(ctx, phone);
    const open = (body: Record<string, string>) => admin.agent.post('/api/inbox/conversations').set('X-CSRF-Token', admin.csrf).send(body);
    const created = await open({ contactId: contact.id, numberId: number.id });
    await check('post', '/inbox/conversations', created, 201);
    await check('post', '/inbox/conversations', await open({ contactId: contact.id, numberId: number.id }), 200);
    await check('post', '/inbox/conversations', await open({ contactId: randomUUID(), numberId: number.id }), 404);

    const template = await seedTemplate(ctx, number.wabaId);
    const send = (params: Record<string, string>) =>
      admin.agent.post(`/api/inbox/conversations/${created.body.id}/template`).set('X-CSRF-Token', admin.csrf).send({ templateId: template.id, params });
    await check('post', '/inbox/conversations/{id}/template', await send({ 'BODY.1': 'Sara' }), 202);
    await check('post', '/inbox/conversations/{id}/template', await send({}), 422);
  });
});
