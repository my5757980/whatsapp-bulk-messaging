import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { TurnService } from '../../src/modules/ai/turns/turn.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T057: US3 - the preview answers with the draft and changes nothing; test numbers meet the
// draft while everyone else meets the published version; versions are listed and restored into the
// draft (FR-005, FR-034, FR-035).
const CLAUDE = 'https://api.anthropic.com';

const response = (fields: Record<string, unknown>) => ({
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
  usage: { input_tokens: 800, output_tokens: 40, cache_read_input_tokens: 1500, cache_creation_input_tokens: 0 },
});

describe('AI agents: testing and versions (US3)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let number: { id: string; phoneNumberId: string };
  let agent: { id: string; name: string; config: Record<string, unknown> };
  let answerId: string;
  const suffix = randomUUID().slice(0, 6);
  const publishedGoal = `Answer questions about the shop ${suffix} (v1).`;
  const draftGoal = `Answer questions about the shop ${suffix} (draft).`;

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const saveDraft = async (patch: Record<string, unknown>) => {
    const current = (await api('get', `/ai-agents/${agent.id}`)).body;
    const saved = await api('put', `/ai-agents/${agent.id}/draft`, { config: { ...current.config, ...patch }, draftRevision: current.draftRevision });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  };
  /** The next Claude call answers with these fields; returns a getter for the request body. */
  const claude = (fields: Record<string, unknown>) => {
    let body = '';
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(async (req: Request) => {
        body = await req.text();
        return [200, response(fields)];
      });
    return () => body;
  };
  const inbound = async (phone: string, text: string) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const turn = (chatId: string) => ctx.app.get(TurnService).run(chatId);
  const aiItem = (chatId: string) => ctx.prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chatId, kind: 'SESSION_OUT', origin: 'AUTOMATIC' } });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
    await ctx.prisma.attributeDefinition.upsert({ where: { key: 'city' }, create: { key: 'city', label: 'City', type: 'TEXT' }, update: {} });
    agent = (await api('post', '/ai-agents', { name: `Tester ${suffix}` })).body;
    answerId = (await api('post', `/ai-agents/${agent.id}/knowledge/answers`, { question: 'When do you open?', answer: 'We open at 9 every day.' })).body.id;
    await saveDraft({ goal: publishedGoal });
    expect((await api('post', `/ai-agents/${agent.id}/publish`)).status).toBe(200);
    expect((await api('put', `/ai-agents/${agent.id}/numbers`, { numberIds: [number.id] })).status).toBe(200);
    // The draft moves on; customers keep meeting version 1.
    await saveDraft({ goal: draftGoal, skills: { ...(agent.config.skills as object), memory: [{ key: 'city', description: "The customer's city" }] } });
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('previews the draft with its sources and what it would do, sending and changing nothing', async () => {
    const before = { contacts: await ctx.prisma.contact.count(), items: await ctx.prisma.chatMessage.count(), months: await ctx.prisma.aiUsageMonth.findMany() };
    const sent = claude({ message: 'We open at 9 every day.', usedSources: [`src:${answerId}`], remember: [{ key: 'city', value: 'Al Ain' }] });
    const res = await api('post', `/ai-agents/${agent.id}/preview`, { messages: [{ from: 'customer', text: 'I live in Al Ain. When do you open?' }], contact: { name: 'Sample customer' } });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.reply.message).toBe(`Hi, I'm ${agent.name}, a virtual assistant.\n\nWe open at 9 every day.`);
    expect(res.body.sources).toMatchObject([{ id: `src:${answerId}`, kind: 'ANSWER' }]);
    expect(res.body.wouldDo).toContainEqual({ kind: 'REMEMBER', description: 'Would save city = Al Ain' });
    expect(res.body.usage.costUsd).toBeGreaterThan(0);
    expect(sent()).toContain(draftGoal);
    expect(sent()).toContain('Sample customer');

    expect(await ctx.prisma.contact.count()).toBe(before.contacts);
    expect(await ctx.prisma.chatMessage.count()).toBe(before.items);
    expect(await ctx.prisma.aiUsageMonth.findMany()).toEqual(before.months);
    expect(await ctx.prisma.aiUsageDaily.findFirst({ where: { agentId: agent.id, kind: 'PREVIEW' } })).toMatchObject({ count: 1 });

    // A later turn of the same preview has the conversation so far and no introduction.
    const later = claude({ message: 'Yes, Saturdays too.', handOver: { reason: 'customer_asked', summary: 'Wants to talk to a person.' } });
    const next = await api('post', `/ai-agents/${agent.id}/preview`, {
      messages: [
        { from: 'customer', text: 'When do you open?' },
        { from: 'agent', text: 'We open at 9 every day.' },
        { from: 'customer', text: 'Saturdays too? And can I talk to someone?' },
      ],
    });
    expect(next.body.reply.message).toBe('Yes, Saturdays too.');
    expect(next.body.wouldDo).toContainEqual({ kind: 'HAND_OVER', description: 'Would hand the chat to your team: Wants to talk to a person.' });
    expect(later()).toContain('We open at 9 every day.');
    expect(await ctx.prisma.conversation.count({ where: { state: 'REQUESTING', numberId: number.id } })).toBe(0);
  });

  it('allows each member 20 previews a minute', async () => {
    const redis = ctx.app.get<Redis>(REDIS_CLIENT);
    await redis.set(`wbm:ai:preview:${manager.userId}`, '20', 'EX', 60);
    try {
      const res = await api('post', `/ai-agents/${agent.id}/preview`, { messages: [{ from: 'customer', text: 'hello' }] });
      expect(res.status).toBe(429);
      expect(res.body.code).toBe('PREVIEW_RATE_LIMITED');
    } finally {
      await redis.del(`wbm:ai:preview:${manager.userId}`);
    }
    expect((await api('post', `/ai-agents/${agent.id}/preview`, { messages: [{ from: 'agent', text: 'Hi' }] })).status).toBe(422);
  });

  it('gives test numbers the draft, marked test, while everyone else meets the published version', async () => {
    const tester = uaePhone();
    const national = `0${tester.slice(4)}`;
    const saved = await api('put', `/ai-agents/${agent.id}/test-numbers`, { testNumbers: [national] });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body.testNumbers).toEqual([tester]);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ai.test_numbers_updated', targetId: agent.id } })).toBe(1);
    expect((await api('put', `/ai-agents/${agent.id}/test-numbers`, { testNumbers: ['12'] })).status).toBe(422);
    expect((await api('put', `/ai-agents/${agent.id}/test-numbers`, { testNumbers: ['+971501111111', '+971501111112', '+971501111113', '+971501111114'] })).status).toBe(422);

    const testChat = await inbound(tester, 'When do you open?');
    const draftRequest = claude({ message: 'We open at 9 every day.' });
    expect(await turn(testChat.id)).toBe('SENT');
    expect(draftRequest()).toContain(draftGoal);
    const testItem = await aiItem(testChat.id);
    expect(testItem.payload).toMatchObject({ ai: { test: true, versionId: null } });
    expect(await ctx.prisma.aiReply.findFirstOrThrow({ where: { chatMessageId: testItem.id } })).toMatchObject({ test: true });
    expect(await ctx.prisma.aiConversation.findFirstOrThrow({ where: { conversationId: testChat.id } })).toMatchObject({ test: true });
    expect(await ctx.prisma.aiUsageDaily.findFirst({ where: { agentId: agent.id, kind: 'REPLY', test: true } })).not.toBeNull();

    const customerChat = await inbound(uaePhone(), 'When do you open?');
    const publishedRequest = claude({ message: 'We open at 9 every day.' });
    expect(await turn(customerChat.id)).toBe('SENT');
    expect(publishedRequest()).toContain(publishedGoal);
    expect((await aiItem(customerChat.id)).payload).toMatchObject({ ai: { test: false } });
  });

  it('lists versions and restores one into the draft while customers keep the published version', async () => {
    expect((await api('post', `/ai-agents/${agent.id}/publish`)).body.publishedVersion.number).toBe(2);
    const versions = await api('get', `/ai-agents/${agent.id}/versions`);
    expect(versions.status).toBe(200);
    expect(versions.body.map((v: { number: number; isCurrent: boolean }) => [v.number, v.isCurrent])).toEqual([
      [2, true],
      [1, false],
    ]);

    const before = (await api('get', `/ai-agents/${agent.id}`)).body;
    const v1 = versions.body[1];
    const restored = await api('post', `/ai-agents/${agent.id}/versions/${v1.id}/restore`);
    expect(restored.status, JSON.stringify(restored.body)).toBe(200);
    expect(restored.body).toMatchObject({ draftRevision: before.draftRevision + 1, hasUnpublishedChanges: true, publishedVersion: { number: 2 } });
    expect(restored.body.config.goal).toBe(publishedGoal);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ai.agent_restored', targetId: agent.id } })).toBe(1);
    expect((await api('post', `/ai-agents/${agent.id}/versions/${randomUUID()}/restore`)).status).toBe(404);

    // Customers keep meeting version 2 until the next publish.
    const chat = await inbound(uaePhone(), 'Are you open on Friday?');
    const request = claude({ message: 'Yes, from 9.' });
    expect(await turn(chat.id)).toBe('SENT');
    expect(request()).toContain(draftGoal);
  });
});
