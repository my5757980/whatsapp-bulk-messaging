import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { TurnService } from '../../src/modules/ai/turns/turn.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T029: US1 - a customer message becomes one debounced AI turn whose validated reply is queued
// on the 002 chat path, counted and recorded (FR-016–FR-021, FR-036; research R5–R8).
const CLAUDE = 'https://api.anthropic.com';

const reply = (fields: Record<string, unknown>) => ({
  id: `msg_${randomUUID()}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    {
      type: 'text',
      text: JSON.stringify({ message: '', language: 'en', buttons: null, list: null, mediaId: null, usedSources: [], unanswered: null, handOver: null, remember: null, startFlow: null, optOut: null, ...fields }),
    },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
});

describe('AI agents: customer turns (US1)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let number: { id: string; phoneNumberId: string };
  let agent: { id: string; name: string };
  let answerId: string;
  const suffix = randomUUID().slice(0, 6);

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const inbound = async (phone: string, text: string) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
  };
  const aiItems = (conversationId: string) => ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: { occurredAt: 'asc' } });
  const turn = (conversationId: string) => ctx.app.get(TurnService).run(conversationId);
  const delayedTurns = async (conversationId: string) =>
    (await ctx.app.get(QueueRegistry).get(QUEUES.AI).getDelayed()).filter((job) => (job.data as { conversationId?: string }).conversationId === conversationId);

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
    const created = (await api('post', '/ai-agents', { name: `Sara ${suffix}` })).body;
    agent = { id: created.id, name: created.name };
    answerId = (await api('post', `/ai-agents/${agent.id}/knowledge/answers`, { question: 'How much is delivery to Sharjah?', answer: 'Delivery to Sharjah costs AED 50.' })).body.id;
    await api('put', `/ai-agents/${agent.id}/draft`, { config: { ...created.config, goal: 'Answer questions about delivery.' }, draftRevision: 0 });
    expect((await api('post', `/ai-agents/${agent.id}/publish`)).status).toBe(200);
    expect((await api('put', `/ai-agents/${agent.id}/numbers`, { numberIds: [number.id] })).status).toBe(200);
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('queues one debounced turn for a burst of messages and answers from the knowledge with the introduction first', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, 'hi');
    await inbound(phone, 'how much is shipping to sharjah?');
    expect(await delayedTurns(chat.id)).toHaveLength(1);

    let sent: { system: Array<{ text: string }>; messages: unknown[] } | undefined;
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(async (req: Request) => {
        sent = (await req.json()) as never;
        return [200, reply({ message: 'Delivery to Sharjah costs AED 50.', usedSources: [`src:${answerId}`] })];
      });
    expect(await turn(chat.id)).toBe('SENT');

    const request = JSON.stringify(sent);
    expect(request).toContain('Delivery to Sharjah costs AED 50.');
    expect(request).toContain('how much is shipping to sharjah?');
    expect(request).not.toContain(phone.slice(1));

    const [item] = await aiItems(chat.id);
    expect(item).toMatchObject({ kind: 'SESSION_OUT', contentType: 'TEXT', status: 'QUEUED' });
    expect(item!.text).toBe(`Hi, I'm ${agent.name}, a virtual assistant.\n\nDelivery to Sharjah costs AED 50.`);
    expect(item!.payload).toMatchObject({ ai: { agentId: agent.id, agentName: agent.name, test: false, sources: [{ id: `src:${answerId}`, kind: 'ANSWER' }] } });
    expect(await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`session-${item!.id}`)).toBeTruthy();

    const record = await ctx.prisma.aiReply.findFirstOrThrow({ where: { chatMessageId: item!.id } });
    expect(record).toMatchObject({ kind: 'REPLY', counted: true, test: false, inputTokens: 1200, cacheReadTokens: 3000, outputTokens: 80 });
    expect(record.costMicros).toBeGreaterThan(0n);
    const usage = await ctx.prisma.aiUsageDaily.findFirstOrThrow({ where: { agentId: agent.id, kind: 'REPLY' } });
    expect(usage.count).toBeGreaterThanOrEqual(1);
    expect(await ctx.prisma.aiConversation.findFirstOrThrow({ where: { conversationId: chat.id } })).toMatchObject({ status: 'ACTIVE', replies: 1, startedBy: 'CUSTOMER' });

    // The next reply has no introduction and the history now holds the first exchange.
    await inbound(phone, 'and to Ajman?');
    let second = '';
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(async (req: Request) => {
        second = await req.text();
        return [200, reply({ message: 'I do not have the Ajman price yet. I can connect you with our team.', unanswered: 'Delivery price to Ajman' })];
      });
    expect(await turn(chat.id)).toBe('SENT');
    // The first exchange is history now, from the AI conversation's first customer message on.
    expect(second).toContain('how much is shipping to sharjah?');
    expect(second).toContain(`Hi, I'm ${agent.name}, a virtual assistant.`);
    expect(second).toContain('and to Ajman?');
    const items = await aiItems(chat.id);
    expect(items).toHaveLength(2);
    expect(items[1]!.text).toBe('I do not have the Ajman price yet. I can connect you with our team.');
    expect(await ctx.prisma.aiUnansweredQuestion.findFirstOrThrow({ where: { agentId: agent.id, resolvedAt: null } })).toMatchObject({ text: 'Delivery price to Ajman', askCount: 1 });
    const open = await api('get', `/ai-agents/${agent.id}/unanswered`);
    expect(open.body.map((q: { text: string }) => q.text)).toContain('Delivery price to Ajman');
  });

  it('answers everything in one reply when a message arrives while the reply is being written', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, 'do you deliver?');
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(async () => {
        await inbound(phone, 'to Sharjah I mean');
        return [200, reply({ message: 'Yes.' })];
      });
    expect(await turn(chat.id)).toBe('NEWER');
    expect(await aiItems(chat.id)).toHaveLength(0);

    let sent = '';
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(async (req: Request) => {
        sent = await req.text();
        return [200, reply({ message: 'Yes, delivery to Sharjah costs AED 50.' })];
      });
    expect(await turn(chat.id)).toBe('SENT');
    expect(sent).toContain('do you deliver?');
    expect(sent).toContain('to Sharjah I mean');
    expect(await aiItems(chat.id)).toHaveLength(1);
  });

  it('sends no welcome message for messages the agent answers', async () => {
    const admin = await signIn(ctx, 'ADMIN');
    const call = (method: 'get' | 'put', url: string, body?: object) => (method === 'get' ? admin.agent.get(`/api${url}`) : admin.agent.put(`/api${url}`).set('X-CSRF-Token', admin.csrf).send(body ?? {}));
    const original = (await call('get', '/live-chat/settings')).body;
    // Welcome messages go out only within working hours (002), so the test opens every hour of the week.
    const always = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
    expect((await call('put', '/live-chat/settings', { ...original, workingHours: always, welcomeEnabled: true, welcomeContent: { kind: 'TEXT', text: `Welcome ${suffix}!` } })).status).toBe(200);
    try {
      const chat = await inbound(uaePhone(), 'Hello there');
      expect((await aiItems(chat.id)).map((i) => i.text)).not.toContain(`Welcome ${suffix}!`);
      expect(await delayedTurns(chat.id)).toHaveLength(1);
    } finally {
      await call('put', '/live-chat/settings', { ...original, welcomeEnabled: false });
    }
  });

  it('answers nothing for numbers without an agent', async () => {
    const other = await seedNumber(ctx);
    const from = uaePhone().slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: other.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'hello' } }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    const chat = await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: `+${from}` } } });
    expect(await delayedTurns(chat.id)).toHaveLength(0);
    expect(await turn(chat.id)).toBe('NOT_ELIGIBLE');
  });
});
