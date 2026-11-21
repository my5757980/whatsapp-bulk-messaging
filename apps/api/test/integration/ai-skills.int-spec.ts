import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TurnService } from '../../src/modules/ai/turns/turn.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T071: US5 - API skills: inputs filled with place-aware encoding and the secret only in a
// header; only mapped fields reach the model; failures give `ok: false`; unsafe addresses are refused
// at publish; secrets are encrypted, returned by name only and protected while used (FR-030, FR-031).
const CLAUDE = 'https://api.anthropic.com';
const SHOP = 'https://shop.example.com';
const TOKEN = `tok_live_${randomUUID().slice(0, 8)}`;

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
  usage: { input_tokens: 600, output_tokens: 30, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});
const toolUse = (name: string, input: Record<string, unknown>) => ({
  id: `msg_${randomUUID()}`,
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content: [{ type: 'tool_use', id: `toolu_${randomUUID().replace(/-/g, '').slice(0, 20)}`, name, input }],
  stop_reason: 'tool_use',
  stop_sequence: null,
  usage: { input_tokens: 600, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

describe('AI agents: API skills (US5)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let number: { id: string; phoneNumberId: string };
  let agentId: string;
  let secretId: string;
  let baseConfig: Record<string, unknown>;
  const suffix = randomUUID().slice(0, 6);

  const api = (method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const orderSkill = (overrides: Record<string, unknown> = {}) => ({
    id: 'order_status',
    name: 'Order status',
    whenToUse: 'When the customer asks where their order is.',
    inputs: [{ key: 'order_number', description: 'The order number', required: true }],
    changesData: false,
    request: { method: 'GET', url: `${SHOP}/api/orders/{input:order_number}`, headers: [{ name: 'Authorization', value: `Bearer {secret:${secretId}}` }], query: [], body: null, timeoutSeconds: 1 },
    map: [{ from: 'order.status', to: 'status' }],
    ...overrides,
  });
  const saveAndPublish = async (skills: unknown[]) => {
    const current = (await api('get', `/ai-agents/${agentId}`)).body;
    const saved = await api('put', `/ai-agents/${agentId}/draft`, { config: { ...baseConfig, skills: { ...(baseConfig.skills as object), api: skills } }, draftRevision: current.draftRevision });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return api('post', `/ai-agents/${agentId}/publish`);
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
  /** Claude asks for the skill, then answers; returns a getter for the second request (with the tool result). */
  const claudeWithTool = (input: Record<string, unknown>, final: Record<string, unknown>) => {
    let second = '';
    nock(CLAUDE).post('/v1/messages').query(true).reply(200, toolUse('skill_order_status', input));
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(async (req: Request) => {
        second = await req.text();
        return [200, reply(final)];
      });
    return () => second;
  };
  const turn = (chatId: string) => ctx.app.get(TurnService).run(chatId);
  const aiItem = (chatId: string) => ctx.prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chatId, kind: 'SESSION_OUT', origin: 'AUTOMATIC' } });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
    const created = (await api('post', '/ai-agents', { name: `Skills ${suffix}` })).body;
    agentId = created.id;
    baseConfig = { ...created.config, goal: 'Help customers track their orders.' };
    expect((await api('put', `/ai-agents/${agentId}/numbers`, { numberIds: [number.id] })).status).toBe(200);
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('stores secrets encrypted, returns them by name only and audits them without values', async () => {
    const created = await api('post', `/ai-agents/${agentId}/secrets`, { name: 'Shop token', value: TOKEN });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(Object.keys(created.body).sort()).toEqual(['id', 'name', 'updatedAt']);
    secretId = created.body.id;
    const row = await ctx.prisma.aiAgentSecret.findUniqueOrThrow({ where: { id: secretId } });
    expect(row.valueEncrypted).not.toContain(TOKEN);
    expect((await api('get', `/ai-agents/${agentId}`)).body.secrets).toEqual([{ id: secretId, name: 'Shop token', updatedAt: expect.any(String) }]);
    const audits = await ctx.prisma.auditLog.findMany({ where: { action: 'ai.secret_changed', targetId: agentId } });
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits)).not.toContain(TOKEN);
  });

  it('refuses http and private addresses at publish', async () => {
    const insecure = await saveAndPublish([orderSkill({ request: { ...orderSkill().request, url: 'http://shop.example.com/api/orders/{input:order_number}' } })]);
    expect(insecure.status).toBe(422);
    expect(insecure.body.problems.map((p: { code: string }) => p.code)).toContain('NOT_HTTPS');
    const privateHost = await saveAndPublish([orderSkill({ request: { ...orderSkill().request, url: 'https://192.168.1.20/api/orders/{input:order_number}' } })]);
    expect(privateHost.body.problems.map((p: { code: string }) => p.code)).toContain('BLOCKED_ADDRESS');
    const missingSecret = await saveAndPublish([orderSkill({ request: { ...orderSkill().request, headers: [{ name: 'Authorization', value: `Bearer {secret:${randomUUID()}}` }] } })]);
    expect(missingSecret.body.problems.map((p: { code: string }) => p.code)).toContain('UNKNOWN_SECRET');
    expect((await saveAndPublish([orderSkill()])).status).toBe(200);
  });

  it('fills the request with place-aware encoding and the secret only in a header, and gives the model only mapped fields', async () => {
    const chat = await inbound(uaePhone(), 'where is my order 10/23?');
    const shop = nock(SHOP)
      .get('/api/orders/10%2F23')
      .matchHeader('authorization', `Bearer ${TOKEN}`)
      .reply(200, { order: { status: 'shipped', internal_note: 'refunded twice, be careful' } });
    const second = claudeWithTool({ order_number: '10/23' }, { message: 'Your order 10/23 has shipped.' });
    expect(await turn(chat.id)).toBe('SENT');
    expect(shop.isDone()).toBe(true);
    expect(second()).toContain('shipped');
    expect(second()).not.toContain('refunded twice');
    expect(second()).not.toContain(TOKEN);
    const item = await aiItem(chat.id);
    expect(item.payload).toMatchObject({ ai: { skills: [{ skillId: 'order_status', name: 'Order status', outcome: 'OK' }] } });
    const record = await ctx.prisma.aiReply.findFirstOrThrow({ where: { chatMessageId: item.id } });
    expect(record.skills).toEqual([{ skillId: 'order_status', name: 'Order status', outcome: 'OK' }]);
    expect(JSON.stringify(record.skills)).not.toContain('10/23');
  });

  it('answers ok: false, never an invented status, on a timeout and a 500', async () => {
    for (const [label, mockShop] of [
      ['timeout', () => nock(SHOP).get('/api/orders/555').delay(2_500).reply(200, { order: { status: 'late' } })],
      ['500', () => nock(SHOP).get('/api/orders/555').reply(500, { error: 'down' })],
    ] as const) {
      const chat = await inbound(uaePhone(), 'order 555 please');
      mockShop();
      const second = claudeWithTool({ order_number: '555' }, { message: 'I cannot check orders right now. I can connect you with our team.' });
      expect(await turn(chat.id), label).toBe('SENT');
      expect(second(), label).toContain(label === 'timeout' ? 'timeout' : 'error_status');
      expect(second(), label).not.toContain('late');
      const record = await ctx.prisma.aiReply.findFirstOrThrow({ where: { chatMessageId: (await aiItem(chat.id)).id } });
      expect(record.skills, label).toEqual([{ skillId: 'order_status', name: 'Order status', outcome: 'FAILED' }]);
    }
  });

  it('runs the skill test request with the same client and rules', async () => {
    nock(SHOP).get('/api/orders/777').matchHeader('authorization', `Bearer ${TOKEN}`).reply(200, { order: { status: 'packed' } });
    const ok = await api('post', `/ai-agents/${agentId}/skill-test`, { skill: orderSkill(), inputs: { order_number: '777' } });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ ok: true, status: 200, mapped: { status: 'packed' }, error: null });
    const blocked = await api('post', `/ai-agents/${agentId}/skill-test`, { skill: orderSkill({ request: { ...orderSkill().request, url: 'https://127.0.0.1/api/orders/1' } }), inputs: {} });
    expect(blocked.body).toMatchObject({ ok: false, error: 'BLOCKED' });
  });

  it('renames secrets and refuses to delete one a skill uses', async () => {
    const renamed = await api('put', `/ai-agents/${agentId}/secrets/${secretId}`, { name: 'Shop API token' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.name).toBe('Shop API token');
    const inUse = await api('delete', `/ai-agents/${agentId}/secrets/${secretId}`);
    expect(inUse.status).toBe(409);
    expect(inUse.body.code).toBe('SECRET_IN_USE');
    const spare = (await api('post', `/ai-agents/${agentId}/secrets`, { name: 'Spare', value: 'unused' })).body;
    expect((await api('delete', `/ai-agents/${agentId}/secrets/${spare.id}`)).status).toBe(204);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ai.secret_changed', targetId: agentId } })).toBe(4);
  });
});
