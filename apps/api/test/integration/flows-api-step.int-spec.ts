import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TokenCipher } from '../../src/common/crypto/token-cipher.js';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { FlowApiProcessor } from '../../src/modules/flows/steps/api-step.processor.js';
import { flowApiJobId } from '../../src/modules/flows/steps/flow-jobs.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 003 T054: US5 API steps with nock - variables and {secret:<id>} in the request, mapping into the
// next message, timeout and 500 on the failed branch, secrets encrypted and never returned or
// audited with their value, and the editor's test request (FR-014, FR-015).
describe('Chatbot flows: API steps and secrets (US5)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string };
  let manager: SignedInAgent;
  let flowId: string;
  let secretId: string;
  const SHOP = 'https://shop.example.com';
  const SECRET_VALUE = `sk-live-${randomUUID()}`;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);

  const api = (method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const inbound = async (phone: string, body: string) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from, profile: { name: 'Sara Khan' } }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body } }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const texts = async (conversationId: string) =>
    (await ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((i) => i.text);
  const apiStep = (timeoutSeconds = 5) => ({
    id: 'lookup',
    type: 'api',
    method: 'GET',
    url: `${SHOP}/orders/{answer:order}`,
    query: [{ name: 'lang', value: 'en' }],
    headers: [
      { name: 'Authorization', value: `Bearer {secret:${secretId}}` },
      { name: 'X-Customer', value: '{first_name}' },
    ],
    timeoutSeconds,
    map: [{ path: 'order.status', answerName: 'status' }],
    success: 'found',
    failed: 'sorry',
  });
  /** A customer whose session waits at the API step after answering the order number. */
  const waitingAtApi = async (order: string) => {
    const phone = uaePhone();
    const chat = await inbound(phone, `order${suffix}`);
    await inbound(phone, order);
    const session = await ctx.prisma.flowSession.findFirstOrThrow({ where: { conversationId: chat.id } });
    expect(session).toMatchObject({ status: 'RUNNING', wait: 'API', currentStepId: 'lookup' });
    return { chat, session };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
    useNockLocalOnly();
    flowId = (await api('post', '/flows', { name: `Order status ${suffix}` })).body.id;
    const secret = await api('post', `/flows/${flowId}/secrets`, { name: 'Shop token', value: SECRET_VALUE });
    expect(secret.status).toBe(201);
    secretId = secret.body.id;
  });

  afterEach(() => {
    nock.cleanAll();
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('stores secrets encrypted, returns names only and audits them without the value', async () => {
    const stored = await ctx.prisma.flowSecret.findUniqueOrThrow({ where: { id: secretId } });
    expect(stored.valueEncrypted).not.toContain(SECRET_VALUE);
    expect(ctx.app.get(TokenCipher).decrypt(stored.valueEncrypted)).toBe(SECRET_VALUE);
    const detail = await api('get', `/flows/${flowId}`);
    expect(detail.body.secrets).toEqual([{ id: secretId, name: 'Shop token', updatedAt: expect.any(String) }]);
    expect(JSON.stringify(detail.body)).not.toContain(SECRET_VALUE);
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'flow.secret_changed', targetId: flowId } });
    expect(audits.length).toBeGreaterThan(0);
    expect(JSON.stringify(audits)).not.toContain(SECRET_VALUE);
  });

  it('fills variables and the secret, maps the reply into the next message, and refuses deleting a used secret', async () => {
    const graph = {
      version: 1,
      start: 'ask',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`order${suffix}`], canInterrupt: false }],
      steps: [
        { id: 'ask', type: 'question', text: 'What is your order number?', answer: { kind: 'text' }, answerName: 'order', retryText: 'Please send the order number.', next: 'lookup' },
        apiStep(1),
        { id: 'found', type: 'message', text: 'Your order {answer:order} is {answer:status}.', next: null },
        { id: 'sorry', type: 'message', text: 'We could not check your order right now.', next: null },
      ],
    };
    expect((await api('put', `/flows/${flowId}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    const published = await api('post', `/flows/${flowId}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);

    const { chat, session } = await waitingAtApi('A-100/1');
    const job = { sessionId: session.id, token: session.waitToken };
    expect(await ctx.app.get(QueueRegistry).get(QUEUES.FLOWS).getJob(flowApiJobId(job))).toBeTruthy();
    const shop = nock(SHOP, { reqheaders: { authorization: `Bearer ${SECRET_VALUE}`, 'x-customer': 'Sara' } })
      .get('/orders/A-100%2F1')
      .query({ lang: 'en' })
      .reply(200, { order: { status: 'shipped' } });
    await ctx.app.get(FlowApiProcessor).run(job);
    expect(shop.isDone()).toBe(true);
    expect(await texts(chat.id)).toEqual(['What is your order number?', 'Your order A-100/1 is shipped.']);
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: 'ENDED', result: 'COMPLETED' });

    const inUse = await api('delete', `/flows/${flowId}/secrets/${secretId}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('SECRET_IN_USE');
  });

  it('takes the failed branch on a timeout and on a 500', async () => {
    const slow = await waitingAtApi('A-200');
    nock(SHOP).get('/orders/A-200').query(true).delay(2_500).reply(200, { order: { status: 'late' } });
    await ctx.app.get(FlowApiProcessor).run({ sessionId: slow.session.id, token: slow.session.waitToken });
    expect((await texts(slow.chat.id)).at(-1)).toBe('We could not check your order right now.');

    const broken = await waitingAtApi('A-300');
    nock(SHOP).get('/orders/A-300').query(true).reply(500, 'Internal error');
    await ctx.app.get(FlowApiProcessor).run({ sessionId: broken.session.id, token: broken.session.waitToken });
    expect((await texts(broken.chat.id)).at(-1)).toBe('We could not check your order right now.');
    const steps = await ctx.prisma.flowSessionStep.findMany({ where: { sessionId: broken.session.id, stepId: 'lookup' } });
    expect(steps.map((s) => s.branch)).toEqual(['failed']);
  });

  it('runs a test request with sample answers through the same client', async () => {
    nock(SHOP, { reqheaders: { authorization: `Bearer ${SECRET_VALUE}` } }).get('/orders/B-1').query({ lang: 'en' }).reply(200, { order: { status: 'packed' } });
    const tested = await api('post', `/flows/${flowId}/api-test`, { step: apiStep(), answers: { order: 'B-1' } });
    expect(tested.status).toBe(200);
    expect(tested.body).toMatchObject({ ok: true, status: 200, body: { order: { status: 'packed' } }, mapped: { status: 'packed' }, error: null });

    const blocked = await api('post', `/flows/${flowId}/api-test`, { step: { ...apiStep(), url: 'https://10.0.0.5/orders' } });
    expect(blocked.body).toMatchObject({ ok: false, status: null, error: 'BLOCKED_ADDRESS' });
  });
});
