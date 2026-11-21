import { randomUUID } from 'node:crypto';
import { DEFAULT_FALLBACK_MESSAGE } from '@wbm/shared';
import type { Redis } from 'ioredis';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry, REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { UNAVAILABLE_NOTE } from '../../src/modules/ai/turns/decisions.js';
import { AiExpiryProcessor } from '../../src/modules/ai/turns/expiry.processor.js';
import { AiFailureMonitor } from '../../src/modules/ai/turns/failure-monitor.js';
import { TurnService } from '../../src/modules/ai/turns/turn.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T048: US2 - the agent hands over to people and keeps the live chat and consent rules
// (FR-016, FR-021–FR-027; research R9, R12).
const CLAUDE = 'https://api.anthropic.com';
const ALWAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
const NEVER = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, []]));

type Number = { id: string; phoneNumberId: string; wabaId: string };
type Chat = { id: string; contactId: string | null };

const response = (fields: Record<string, unknown>, stopReason = 'end_turn') => ({
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
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0 },
});

describe('AI agents: hand-over and live chat rules (US2)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let member: SignedInAgent;
  let admin: SignedInAgent;
  let number: Number;
  let unsureNumber: Number;
  let sara: { id: string; name: string };
  let careful: { id: string; name: string };
  let original: Record<string, unknown>;
  const suffix = randomUUID().slice(0, 6);

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const settings = (patch: Record<string, unknown>) => api(admin, 'put', '/live-chat/settings', { ...original, workingHours: ALWAYS, welcomeEnabled: false, offHoursEnabled: false, ...patch });
  const inbound = async (to: Number, phone: string, text: string): Promise<Chat> => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: to.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: to.id }, select: { id: true, contactId: true } });
  };
  /** The next Claude call answers with these reply fields; returns a getter for the request body. */
  const claude = (fields: Record<string, unknown>, during?: () => Promise<unknown>) => {
    let body = '';
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(async (req: Request) => {
        body = await req.text();
        if (during) await during();
        return [200, response(fields)];
      });
    return () => body;
  };
  const turn = (chat: Chat) => ctx.app.get(TurnService).run(chat.id);
  const aiItems = (chat: Chat) => ctx.prisma.chatMessage.findMany({ where: { conversationId: chat.id, kind: 'SESSION_OUT', origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const notes = (chat: Chat) => ctx.prisma.chatMessage.findMany({ where: { conversationId: chat.id, kind: 'NOTE' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const aiConversations = (chat: Chat) => ctx.prisma.aiConversation.findMany({ where: { conversationId: chat.id }, orderBy: { startedAt: 'asc' } });
  const state = async (chat: Chat) => (await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).state;
  /** A chat on Sara's number whose AI conversation is active after one answer. */
  const answeredChat = async () => {
    const phone = uaePhone();
    const chat = await inbound(number, phone, 'hi there');
    claude({ message: 'Hello! How can I help?' });
    expect(await turn(chat)).toBe('SENT');
    expect((await aiConversations(chat)).map((c) => c.status)).toEqual(['ACTIVE']);
    return { phone, chat };
  };
  const publishAgent = async (name: string, numberId: string, patch: Record<string, unknown>) => {
    const created = (await api(manager, 'post', '/ai-agents', { name })).body;
    const saved = await api(manager, 'put', `/ai-agents/${created.id}/draft`, { config: { ...created.config, goal: 'Help customers with orders and delivery.', ...patch }, draftRevision: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await api(manager, 'post', `/ai-agents/${created.id}/publish`)).status).toBe(200);
    expect((await api(manager, 'put', `/ai-agents/${created.id}/numbers`, { numberIds: [numberId] })).status).toBe(200);
    return { id: created.id as string, name };
  };
  const publishFlow = async (keyword: string) => {
    const flow = (await api(manager, 'post', '/flows', { name: `Menu ${keyword}` })).body;
    const graph = {
      version: 1,
      start: 'hello',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
      steps: [{ id: 'hello', type: 'message', text: `Flow says hi ${keyword}`, next: null }],
    };
    expect((await api(manager, 'put', `/flows/${flow.id}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    expect((await api(manager, 'post', `/flows/${flow.id}/publish`)).status).toBe(200);
    return flow.id as string;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    member = await signIn(ctx, 'AGENT');
    admin = await signIn(ctx, 'ADMIN');
    original = (await api(admin, 'get', '/live-chat/settings')).body;
    expect((await settings({ humanKeywords: ['TALK TO SOMEONE'] })).status).toBe(200);
    number = await seedNumber(ctx);
    unsureNumber = await seedNumber(ctx);
    sara = await publishAgent(`Sara ${suffix}`, number.id, { handOverTopics: ['refunds'] });
    careful = await publishAgent(`Careful ${suffix}`, unsureNumber.id, { whenUnsure: 'hand_over' });
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    await api(admin, 'put', '/live-chat/settings', original);
    restoreNetwork();
    await ctx.close();
  });

  it('hands over when the customer asks for a person: one closing reply, Waiting for agent with the alert and a summary note', async () => {
    const phone = uaePhone();
    const chat = await inbound(number, phone, 'can I speak to someone from your team?');
    claude({ message: 'Of course. A member of our team will reply here shortly.', handOver: { reason: 'customer_asked', summary: 'Wants to talk to a person about an order.' } });
    expect(await turn(chat)).toBe('SENT');

    const [closing, ...more] = await aiItems(chat);
    expect(more).toHaveLength(0);
    expect(closing!.text).toContain('A member of our team will reply here shortly.');
    expect(closing!.payload).toMatchObject({ ai: { agentId: sara.id, handOver: 'customer_asked' } });
    expect(await ctx.prisma.aiReply.findFirstOrThrow({ where: { chatMessageId: closing!.id } })).toMatchObject({ kind: 'HANDOVER', counted: true });
    expect(await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ state: 'REQUESTING', unresolvedRequests: 1 });
    expect(await ctx.prisma.conversationEvent.findFirstOrThrow({ where: { conversationId: chat.id, type: 'REQUESTED' } })).toMatchObject({ actorType: 'AI_AGENT' });
    const [note] = await notes(chat);
    expect(note).toMatchObject({ origin: 'AUTOMATIC', text: `${sara.name} handed this chat over. The customer asked for a person.\nWants to talk to a person about an order.` });
    expect(await ctx.prisma.notification.count({ where: { type: 'INBOX_REQUESTING', link: `/inbox?c=${chat.id}` } })).toBeGreaterThan(0);
    expect(await aiConversations(chat)).toMatchObject([{ status: 'ENDED', result: 'HANDED_OVER' }]);
    expect(await ctx.prisma.conversationEvent.count({ where: { conversationId: chat.id, type: 'AI_ENDED' } })).toBe(1);

    // The agent stays silent while the chat waits for a person.
    await inbound(number, phone, 'hello? anyone?');
    expect(await turn(chat)).toBe('NOT_ELIGIBLE');
    expect(await aiItems(chat)).toHaveLength(1);
  });

  it('hands over on a hand-over topic the manager chose', async () => {
    const chat = await inbound(number, uaePhone(), 'I want my money back for my order');
    const sent = claude({ message: 'I understand. Our team handles refunds and will reply here soon.', handOver: { reason: 'topic', summary: 'Refund for an order.' } });
    expect(await turn(chat)).toBe('SENT');
    expect(sent()).toContain('Hand-over topics: refunds');
    expect((await notes(chat))[0]?.text).toBe(`${sara.name} handed this chat over. The message is about a hand-over topic.\nRefund for an order.`);
    expect(await state(chat)).toBe('REQUESTING');
  });

  it('says so and offers a person by default when it cannot answer, and hands over when set to', async () => {
    const unsure = { message: "I don't have that information yet. I can connect you with our team.", unanswered: 'Price of the XL sofa' };
    const sayChat = await inbound(number, uaePhone(), 'how much is the XL sofa?');
    claude(unsure);
    expect(await turn(sayChat)).toBe('SENT');
    expect(await state(sayChat)).toBe('ACTIVE');
    expect(await notes(sayChat)).toHaveLength(0);

    const handChat = await inbound(unsureNumber, uaePhone(), 'how much is the XL sofa?');
    const sent = claude(unsure);
    expect(await turn(handChat)).toBe('SENT');
    expect(sent()).toContain('When you cannot answer: hand the chat over');
    expect(await state(handChat)).toBe('REQUESTING');
    expect((await notes(handChat))[0]?.text).toBe(`${careful.name} handed this chat over. The agent could not answer.\nCould not answer: Price of the XL sofa`);
    expect(await aiConversations(handChat)).toMatchObject([{ status: 'ENDED', result: 'HANDED_OVER' }]);
  });

  it('hands over on a second question it cannot answer, and once the reply cap is reached', async () => {
    const phone = uaePhone();
    const chat = await inbound(number, phone, 'do you deliver to Oman?');
    claude({ message: "I don't know yet. I can connect you with our team.", unanswered: 'Delivery to Oman' });
    expect(await turn(chat)).toBe('SENT');
    expect(await state(chat)).toBe('ACTIVE');
    await inbound(number, phone, 'and to Bahrain?');
    const second = claude({ message: "I don't know that either.", unanswered: 'Delivery to Bahrain' });
    expect(await turn(chat)).toBe('SENT');
    expect(second()).toContain('Earlier in this conversation you could not answer a question.');
    expect(await state(chat)).toBe('REQUESTING');
    expect((await notes(chat))[0]?.text).toBe(`${sara.name} handed this chat over. The agent could not answer a second question.\nCould not answer again: Delivery to Bahrain`);

    const capped = await answeredChat();
    const [conversation] = await aiConversations(capped.chat);
    await ctx.prisma.aiConversation.update({ where: { id: conversation!.id }, data: { replies: 20 } });
    await inbound(number, capped.phone, 'one more thing');
    const last = claude({ message: 'Thanks for chatting! A member of our team will take it from here.' });
    expect(await turn(capped.chat)).toBe('SENT');
    expect(last()).toContain('reached its reply limit');
    expect(await state(capped.chat)).toBe('REQUESTING');
    expect((await notes(capped.chat))[0]?.text).toBe(`${sara.name} handed this chat over. The conversation reached the reply limit.`);
  });

  it('outside working hours the hand-over reply is the only automatic message', async () => {
    expect((await settings({ workingHours: NEVER, offHoursEnabled: true, offHoursContent: { kind: 'TEXT', text: `Closed now ${suffix}` } })).status).toBe(200);
    try {
      const chat = await inbound(number, uaePhone(), 'can someone call me?');
      const sent = claude({ message: 'Our team is away and will reply when they are back.', handOver: { reason: 'customer_asked', summary: 'Wants a call back.' } });
      expect(await turn(chat)).toBe('SENT');
      expect(sent()).toContain('The team is away');
      const texts = (await ctx.prisma.chatMessage.findMany({ where: { conversationId: chat.id, origin: 'AUTOMATIC' } })).map((i) => i.text);
      expect(texts.some((t) => t?.includes(`Closed now ${suffix}`))).toBe(false);
      expect(await state(chat)).toBe('REQUESTING');
    } finally {
      await settings({});
    }
  });

  it('a member taking the chat drops the reply being prepared; replies, templates and starting a flow stop the agent too', async () => {
    const taken = await answeredChat();
    await inbound(number, taken.phone, 'what are your opening hours?');
    claude({ message: 'We open at 9.' }, () => api(member, 'post', `/inbox/conversations/${taken.chat.id}/intervene`));
    expect(await turn(taken.chat)).toBe('DROPPED');
    expect(await aiItems(taken.chat)).toHaveLength(1);
    expect(await aiConversations(taken.chat)).toMatchObject([{ status: 'ENDED', result: 'MEMBER_TOOK' }]);
    await inbound(number, taken.phone, 'hello?');
    expect(await turn(taken.chat)).toBe('NOT_ELIGIBLE');

    const replied = await answeredChat();
    expect((await api(member, 'post', `/inbox/conversations/${replied.chat.id}/messages`, { type: 'text', text: 'Hi, I can help.' })).status).toBe(202);
    expect(await aiConversations(replied.chat)).toMatchObject([{ status: 'ENDED', result: 'MEMBER_TOOK' }]);

    const templated = await answeredChat();
    await ctx.prisma.contact.update({ where: { phoneE164: templated.phone }, data: { consentStatus: 'OPTED_IN' } });
    const template = await seedTemplate(ctx, number.wabaId);
    const sent = await api(member, 'post', `/inbox/conversations/${templated.chat.id}/template`, { templateId: template.id, params: { 'BODY.1': 'Sara' } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(await aiConversations(templated.chat)).toMatchObject([{ status: 'ENDED', result: 'MEMBER_TOOK' }]);

    const flowed = await answeredChat();
    const flowId = await publishFlow(`start${suffix}`);
    const started = await api(member, 'post', `/inbox/conversations/${flowed.chat.id}/flows`, { flowId });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(await aiConversations(flowed.chat)).toMatchObject([{ status: 'ENDED', result: 'MEMBER_TOOK' }]);
  });

  it('answers again after a member closes the chat, in a new AI conversation', async () => {
    const { phone, chat } = await answeredChat();
    expect((await api(member, 'post', `/inbox/conversations/${chat.id}/intervene`)).status).toBe(200);
    expect((await api(member, 'post', `/inbox/conversations/${chat.id}/resolve`)).status).toBe(200);
    await inbound(number, phone, 'one more question please');
    claude({ message: 'Sure, ask away.' });
    expect(await turn(chat)).toBe('SENT');
    expect((await aiConversations(chat)).map((c) => [c.status, c.result])).toEqual([
      ['ENDED', 'MEMBER_TOOK'],
      ['ACTIVE', null],
    ]);
    expect((await aiItems(chat)).at(-1)?.text).toBe(`Hi, I'm ${sara.name}, a virtual assistant.\n\nSure, ask away.`);
  });

  it('gives STOP no AI reply and ends the AI conversation', async () => {
    const { phone, chat } = await answeredChat();
    await inbound(number, phone, 'STOP');
    expect(await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } })).toMatchObject({ consentStatus: 'OPTED_OUT', consentSource: 'KEYWORD' });
    expect(await aiConversations(chat)).toMatchObject([{ status: 'ENDED', result: 'OPTED_OUT' }]);
    expect(await turn(chat)).toBe('NOT_ELIGIBLE');
    expect(await aiItems(chat)).toHaveLength(1);
  });

  it('records a clear request in other words as an opt-out by the AI agent and sends nothing; an unclear one gets a question', async () => {
    const phone = uaePhone();
    const chat = await inbound(number, phone, 'please never message me again');
    claude({ message: '', optOut: 'clear' });
    expect(await turn(chat)).toBe('OPTED_OUT');
    expect(await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } })).toMatchObject({ consentStatus: 'OPTED_OUT', consentSource: 'AI_AGENT' });
    const event = await ctx.prisma.consentEvent.findFirstOrThrow({ where: { contact: { phoneE164: phone } }, orderBy: { createdAt: 'desc' } });
    expect(event).toMatchObject({ status: 'OPTED_OUT', source: 'AI_AGENT' });
    expect(event.note).toContain('please never message me again');
    expect(await aiItems(chat)).toHaveLength(0);

    const unclear = await inbound(number, uaePhone(), 'so many offers lately');
    claude({ message: 'Would you like to stop receiving messages from us?', optOut: 'ask' });
    expect(await turn(unclear)).toBe('SENT');
    expect((await aiItems(unclear))[0]?.text).toContain('Would you like to stop receiving messages from us?');
    expect((await ctx.prisma.contact.findUniqueOrThrow({ where: { id: unclear.contactId! } })).consentStatus).not.toBe('OPTED_OUT');
  });

  it('sends nothing to a blocked contact and ends the AI conversation', async () => {
    const { phone, chat } = await answeredChat();
    expect((await api(manager, 'post', `/contacts/${chat.contactId}/block`)).status).toBe(204);
    expect(await aiConversations(chat)).toMatchObject([{ status: 'ENDED', result: 'BLOCKED' }]);
    await inbound(number, phone, 'hello?');
    expect(await turn(chat)).toBe('NOT_ELIGIBLE');
    expect(await aiItems(chat)).toHaveLength(1);
  });

  it('lets a flow keyword win over the agent', async () => {
    const keyword = `menu${suffix}`;
    await publishFlow(keyword);
    const chat = await inbound(number, uaePhone(), keyword);
    const delayed = (await ctx.app.get(QueueRegistry).get(QUEUES.AI).getDelayed()).filter((job) => (job.data as { conversationId?: string }).conversationId === chat.id);
    expect(delayed).toHaveLength(0);
    expect(await ctx.prisma.chatMessage.count({ where: { conversationId: chat.id, aiPending: true } })).toBe(0);
    expect((await ctx.prisma.chatMessage.findMany({ where: { conversationId: chat.id, origin: 'AUTOMATIC' } })).map((i) => i.text)).toEqual([`Flow says hi ${keyword}`]);
  });

  it('sends the fallback message, hands over and counts nothing when the AI service fails', async () => {
    const usageBefore = await ctx.prisma.aiUsageDaily.aggregate({ where: { agentId: sara.id }, _sum: { count: true } });
    const failures: Array<[string, () => void]> = [
      ['invalid JSON', () => nock(CLAUDE).post('/v1/messages').query(true).reply(200, { ...response({}), content: [{ type: 'text', text: 'Sure! Here you go' }] })],
      ['a refusal', () => nock(CLAUDE).post('/v1/messages').query(true).reply(200, { ...response({}), content: [], stop_reason: 'refusal' })],
      ['a rejected key', () => nock(CLAUDE).post('/v1/messages').query(true).reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } })],
    ];
    for (const [label, fail] of failures) {
      const chat = await inbound(number, uaePhone(), `question ${label}`);
      fail();
      expect(await turn(chat), label).toBe('FAILED');
      const [item] = await aiItems(chat);
      expect(item!.text, label).toBe(`Hi, I'm ${sara.name}, a virtual assistant.\n\n${DEFAULT_FALLBACK_MESSAGE}`);
      expect(await ctx.prisma.aiReply.findFirstOrThrow({ where: { chatMessageId: item!.id } }), label).toMatchObject({ kind: 'FALLBACK', counted: false });
      expect((await notes(chat))[0]?.text, label).toBe(UNAVAILABLE_NOTE);
      expect(await state(chat), label).toBe('REQUESTING');
      expect(await aiConversations(chat), label).toMatchObject([{ status: 'ENDED', result: 'FAILED' }]);
    }
    const usageAfter = await ctx.prisma.aiUsageDaily.aggregate({ where: { agentId: sara.id }, _sum: { count: true } });
    expect(usageAfter._sum.count).toBe(usageBefore._sum.count);
  });

  it('alerts admins once an hour when more than 20% of AI replies fail within 15 minutes', async () => {
    await ctx.app.get<Redis>(REDIS_CLIENT).del('wbm:ai:failing-alert');
    const { chat } = await answeredChat();
    const [conversation] = await aiConversations(chat);
    await ctx.prisma.aiReply.createMany({
      data: Array.from({ length: 20 }, () => ({ aiConversationId: conversation!.id, agentId: sara.id, kind: 'FALLBACK' as const, modelId: 'claude-opus-5-5' })),
    });
    const before = await ctx.prisma.notification.count({ where: { type: 'AI_FAILING' } });
    const monitor = ctx.app.get(AiFailureMonitor);
    expect(await monitor.check()).toBe(true);
    expect(await ctx.prisma.notification.count({ where: { type: 'AI_FAILING' } })).toBeGreaterThan(before);
    expect(await monitor.check()).toBe(false);
  });

  it('ends AI conversations that were idle for 24 hours', async () => {
    const { chat } = await answeredChat();
    const [conversation] = await aiConversations(chat);
    await ctx.prisma.aiConversation.update({ where: { id: conversation!.id }, data: { lastActivityAt: new Date(Date.now() - 25 * 3_600_000) } });
    expect(await ctx.app.get(AiExpiryProcessor).sweep()).toBeGreaterThanOrEqual(1);
    expect(await aiConversations(chat)).toMatchObject([{ status: 'ENDED', result: 'EXPIRED' }]);
  });
});
