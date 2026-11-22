import { randomUUID } from 'node:crypto';
import { monthKey } from '@wbm/shared';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TurnService } from '../../src/modules/ai/turns/turn.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T085: US7 - every AI reply counts against the monthly limit (FR-036–FR-039, research R10).
const CLAUDE = 'https://api.anthropic.com';

const response = (message: string) => ({
  id: `msg_${randomUUID()}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [
    {
      type: 'text',
      text: JSON.stringify({ message, language: 'en', buttons: null, list: null, mediaId: null, usedSources: [], unanswered: null, handOver: null, remember: null, startFlow: null, optOut: null }),
    },
  ],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 1000, output_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

describe('AI agents: usage, monthly limit and cost (US7)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let number: { id: string; phoneNumberId: string };
  let agent: { id: string; name: string };
  let month: string;
  let original: Record<string, unknown>;
  const suffix = randomUUID().slice(0, 6);
  const LIMIT_MESSAGE = `Our team will reply soon ${suffix}.`;

  const call = (who: SignedInAgent, method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const setLimit = async (replyLimit: number) => {
    const saved = await call(admin, 'put', '/ai-settings', { ...original, replyLimit, limitMessage: LIMIT_MESSAGE });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  };
  const usage = async () => (await call(admin, 'get', '/ai-usage')).body;
  const inbound = async (phone: string, text: string) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: text } }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const claude = (message: string) => nock(CLAUDE).post('/v1/messages').query(true).reply(200, response(message));
  const turn = (chatId: string) => ctx.app.get(TurnService).run(chatId);
  const alerts = (title: string) => ctx.prisma.notification.count({ where: { type: 'AI_USAGE', title } });
  /** One customer question answered by the agent. */
  const answered = async (phone = uaePhone()) => {
    const chat = await inbound(phone, `question ${randomUUID().slice(0, 4)}`);
    claude('Here you go.');
    expect(await turn(chat.id)).toBe('SENT');
    return chat;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
    original = (await call(admin, 'get', '/ai-settings')).body;
    const created = (await call(manager, 'post', '/ai-agents', { name: `Counter ${suffix}` })).body;
    agent = { id: created.id, name: created.name };
    expect((await call(manager, 'put', `/ai-agents/${agent.id}/draft`, { config: { ...created.config, goal: 'Answer questions.' }, draftRevision: 0 })).status).toBe(200);
    expect((await call(manager, 'post', `/ai-agents/${agent.id}/publish`)).status).toBe(200);
    expect((await call(manager, 'put', `/ai-agents/${agent.id}/numbers`, { numberIds: [number.id] })).status).toBe(200);
    // The month's count is shared with other files: this file starts it from zero.
    const settings = await ctx.prisma.settings.findUniqueOrThrow({ where: { id: 1 }, select: { defaultTimezone: true } });
    month = monthKey(new Date(), settings.defaultTimezone);
    await ctx.prisma.$executeRaw`DELETE FROM ai_usage_months WHERE month = ${month}::date`;
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    await call(admin, 'put', '/ai-settings', original);
    restoreNetwork();
    await ctx.close();
  });

  it('counts replies up to the limit, alerts at 80% and 100% once, and hands the next message over without a model call', async () => {
    await setLimit(5);
    const eighty = await alerts('AI replies at 80% of the limit');
    const full = await alerts('AI reply limit reached');
    for (let i = 1; i <= 5; i += 1) {
      await answered();
      expect((await usage()).replies, `reply ${i}`).toBe(i);
      if (i === 3) expect(await alerts('AI replies at 80% of the limit')).toBe(eighty);
    }
    expect(await alerts('AI replies at 80% of the limit')).toBeGreaterThan(eighty);
    expect(await alerts('AI reply limit reached')).toBeGreaterThan(full);
    const afterAlerts = { eighty: await alerts('AI replies at 80% of the limit'), full: await alerts('AI reply limit reached') };

    // The sixth: no Claude call is set up, so a call would fail the turn instead of limiting it.
    const chat = await inbound(uaePhone(), 'one more question');
    expect(await turn(chat.id)).toBe('LIMITED');
    expect((await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).state).toBe('REQUESTING');
    const items = await ctx.prisma.chatMessage.findMany({ where: { conversationId: chat.id, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
    expect(items.map((i) => i.kind)).toEqual(['SESSION_OUT', 'NOTE']);
    expect(items[0]!.text).toBe(`Hi, I'm ${agent.name}, a virtual assistant.\n\n${LIMIT_MESSAGE}`);
    expect(items[1]!.text).toContain('AI reply limit reached');
    expect(await ctx.prisma.aiReply.findFirstOrThrow({ where: { chatMessageId: items[0]!.id } })).toMatchObject({ kind: 'LIMIT', counted: false });
    expect(await ctx.prisma.aiConversation.findFirstOrThrow({ where: { conversationId: chat.id } })).toMatchObject({ status: 'ENDED', result: 'LIMIT_REACHED' });
    expect((await usage()).replies).toBe(5);
    expect({ eighty: await alerts('AI replies at 80% of the limit'), full: await alerts('AI reply limit reached') }).toEqual(afterAlerts);
  });

  it('resumes as soon as the limit is raised', async () => {
    await setLimit(6);
    await answered();
    expect((await usage()).replies).toBe(6);
  });

  it('lets exactly one of two turns through when one reply is left', async () => {
    await setLimit(7);
    const first = await inbound(uaePhone(), 'first at the same time');
    const second = await inbound(uaePhone(), 'second at the same time');
    claude('Answer one.');
    claude('Answer two.');
    const results = await Promise.all([turn(first.id), turn(second.id)]);
    expect([...results].sort()).toEqual(['LIMITED', 'SENT']);
    expect((await usage()).replies).toBe(7);
  });

  it('counts test replies towards the limit and shows them apart; fallback messages are not counted', async () => {
    await setLimit(100);
    const tester = uaePhone();
    expect((await call(manager, 'put', `/ai-agents/${agent.id}/test-numbers`, { testNumbers: [tester] })).status).toBe(200);
    const before = await usage();
    await answered(tester);
    const after = await usage();
    expect(after.replies).toBe(before.replies + 1);
    expect(after.testReplies).toBe(before.testReplies + 1);

    const failing = await inbound(uaePhone(), 'this one fails');
    nock(CLAUDE).post('/v1/messages').query(true).reply(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    expect(await turn(failing.id)).toBe('FAILED');
    expect((await usage()).replies).toBe(after.replies);
  });

  it('reports totals, agents, days, outcomes and cost that match the records', async () => {
    const report = await usage();
    expect(report.month).toBe(month.slice(0, 7));
    const [monthRow] = await ctx.prisma.$queryRaw<Array<{ replies: number }>>`SELECT replies FROM ai_usage_months WHERE month = ${month}::date`;
    expect(report.replies).toBe(Number(monthRow!.replies));

    const next = month.slice(0, 7) === `${month.slice(0, 4)}-12` ? `${Number(month.slice(0, 4)) + 1}-01-01` : `${month.slice(0, 5)}${String(Number(month.slice(5, 7)) + 1).padStart(2, '0')}-01`;
    const [rows] = await ctx.prisma.$queryRaw<Array<{ cost: bigint; mine_replies: bigint; mine_test: bigint }>>`
      SELECT COALESCE(sum(cost_micros), 0)::bigint AS cost,
             COALESCE(sum(count) FILTER (WHERE kind = 'REPLY' AND agent_id = ${agent.id}::uuid AND NOT test), 0)::bigint AS mine_replies,
             COALESCE(sum(count) FILTER (WHERE kind = 'REPLY' AND agent_id = ${agent.id}::uuid AND test), 0)::bigint AS mine_test
        FROM ai_usage_daily WHERE day >= ${month}::date AND day < ${next}::date`;
    expect(report.estimatedCostUsd).toBeCloseTo(Number(rows!.cost) / 1_000_000, 6);
    expect(report.byAgent.find((a: { agentId: string }) => a.agentId === agent.id)).toMatchObject({ name: agent.name, replies: Number(rows!.mine_replies), testReplies: Number(rows!.mine_test) });
    expect(report.byDay.length).toBeGreaterThan(0);
    expect(report.conversations.limitReached).toBeGreaterThanOrEqual(2);
    expect(report.conversations.failed).toBeGreaterThanOrEqual(1);

    const previous = Number(month.slice(5, 7)) === 1 ? `${Number(month.slice(0, 4)) - 1}-12` : `${month.slice(0, 5)}${String(Number(month.slice(5, 7)) - 1).padStart(2, '0')}`;
    const earlier = await call(admin, 'get', `/ai-usage?month=${previous}`);
    expect(earlier.status).toBe(200);
    expect(earlier.body.month).toBe(previous);
    expect((await call(admin, 'get', '/ai-usage?month=2026-13')).status).toBe(422);
  });

  it('is for admins only, and changing the limits is audited', async () => {
    expect((await call(manager, 'get', '/ai-usage')).status).toBe(403);
    expect((await call(manager, 'put', '/ai-settings', original)).status).toBe(403);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ai.limits_changed' } })).toBeGreaterThan(0);
  });
});
