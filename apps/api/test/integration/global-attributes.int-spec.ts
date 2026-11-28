import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TurnService } from '../../src/modules/ai/turns/turn.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { digits, restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T043 (feature 010 US3, FR-014 – FR-016, research R7): global attributes in campaign variables, saved
// replies, flow messages and AI agent instructions; deletion refused while in use.
const CLAUDE = 'https://api.anthropic.com';
const ALWAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));

type Number = { id: string; phoneNumberId: string; wabaId: string };
type Chat = { id: string; contactId: string | null };

const claudeReply = (message: string) => ({
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
  usage: { input_tokens: 900, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
});

describe('Global attributes (010 US3)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let number: Number;
  let aiNumber: Number;
  let original: Record<string, unknown>;
  const suffix = digits(6);
  const key = (name: string) => `${name}_${suffix}`;

  const send = (who: SignedInAgent, method: 'post' | 'put' | 'delete', path: string, body?: object) => who.agent[method](`/api${path}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const create = async (k: string, value: string) => {
    const res = await send(admin, 'post', '/global-attributes', { key: k, description: `Test ${k}`, value });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body as { id: string; key: string; value: string };
  };
  const inbound = async (to: Number, phone: string, text: string): Promise<Chat> => {
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(to.phoneNumberId, phone.slice(1), text)));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: to.id }, select: { id: true, contactId: true } });
  };
  const automatic = async (chat: Chat) =>
    (await ctx.prisma.chatMessage.findMany({ where: { conversationId: chat.id, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] })).map((m) => m.text);
  const publishFlow = async (keyword: string, text: string) => {
    const flow = (await send(manager, 'post', '/flows', { name: `Hours ${keyword}` })).body;
    const graph = {
      version: 1,
      start: 'hello',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
      steps: [{ id: 'hello', type: 'message', text, next: null }],
    };
    expect((await send(manager, 'put', `/flows/${flow.id}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    expect((await send(manager, 'post', `/flows/${flow.id}/publish`)).status).toBe(200);
    return flow.id as string;
  };
  const publishAgent = async (name: string, numberId: string, patch: Record<string, unknown>) => {
    const created = (await send(manager, 'post', '/ai-agents', { name })).body;
    const saved = await send(manager, 'put', `/ai-agents/${created.id}/draft`, { config: { ...created.config, goal: 'Help customers with orders and delivery.', ...patch }, draftRevision: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await send(manager, 'post', `/ai-agents/${created.id}/publish`)).status).toBe(200);
    expect((await send(manager, 'put', `/ai-agents/${created.id}/numbers`, { numberIds: [numberId] })).status).toBe(200);
    return created.id as string;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    [admin, manager, agent] = await Promise.all([signIn(ctx, 'ADMIN'), signIn(ctx, 'MANAGER'), signIn(ctx, 'AGENT')]);
    original = (await admin.agent.get('/api/live-chat/settings')).body;
    expect((await send(admin, 'put', '/live-chat/settings', { ...original, workingHours: ALWAYS, welcomeEnabled: false, offHoursEnabled: false })).status).toBe(200);
    number = await seedNumber(ctx);
    aiNumber = await seedNumber(ctx);
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    await send(admin, 'put', '/live-chat/settings', original);
    restoreNetwork();
    await ctx.close();
  });

  it('keeps global attributes for admins; every role can list them', async () => {
    const hours = await create(key('hours'), '9 am to 9 pm');
    expect(hours).toMatchObject({ key: key('hours'), value: '9 am to 9 pm', description: `Test ${key('hours')}` });

    const taken = await send(admin, 'post', '/global-attributes', { key: key('hours'), value: 'again' });
    expect(taken.status).toBe(409);
    expect(taken.body.code).toBe('KEY_TAKEN');
    expect((await send(admin, 'post', '/global-attributes', { key: 'Store Hours', value: 'x' })).status).toBe(422);
    expect((await send(manager, 'post', '/global-attributes', { key: key('nope'), value: 'x' })).status).toBe(403);
    expect((await send(manager, 'put', `/global-attributes/${hours.id}`, { value: 'x' })).status).toBe(403);

    for (const who of [admin, manager, agent]) {
      const listed = await who.agent.get('/api/global-attributes');
      expect(listed.status).toBe(200);
      expect(listed.body.items).toEqual(expect.arrayContaining([expect.objectContaining({ id: hours.id, key: key('hours'), value: '9 am to 9 pm' })]));
    }

    const changed = await send(admin, 'put', `/global-attributes/${hours.id}`, { description: 'Opening hours', value: '10 am to 10 pm' });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ value: '10 am to 10 pm', description: 'Opening hours', updatedBy: expect.any(String) });
    expect(await ctx.prisma.auditLog.findMany({ where: { targetId: hours.id }, select: { action: true }, orderBy: { createdAt: 'asc' } })).toEqual([
      { action: 'global_attribute.created' },
      { action: 'global_attribute.updated' },
    ]);
  });

  it('fills a campaign variable at launch and refuses a launch while the value is empty', async () => {
    const promo = await create(key('promo'), 'SAVE10');
    const empty = await create(key('empty'), '');
    const tag = await ctx.prisma.tag.create({ data: { name: `global-${suffix}` } });
    const contact = await seedContact(ctx, uaePhone(), { name: 'Global person' });
    await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
    const template = await seedTemplate(ctx, number.wabaId);
    const draft = (globalKey: string) =>
      send(manager, 'post', '/campaigns', {
        name: `Global ${globalKey}`,
        numberId: number.id,
        templateId: template.id,
        audienceType: 'FILTER',
        audienceFilter: { all: [{ tag: tag.name }] },
        variableMapping: { 'BODY.1': { source: 'global', key: globalKey } },
      });

    const blocked = await draft(empty.key);
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(201);
    const estimate = await send(manager, 'post', `/campaigns/${blocked.body.id}/estimate`);
    expect(estimate.status).toBe(422);
    expect(estimate.body).toMatchObject({ code: 'GLOBAL_ATTRIBUTE_EMPTY', details: [{ field: `global.${empty.key}`, issue: 'has no value' }] });
    expect((await send(manager, 'post', `/campaigns/${blocked.body.id}/launch`, {})).body.code).toBe('GLOBAL_ATTRIBUTE_EMPTY');

    const ok = await draft(promo.key);
    const launched = await send(manager, 'post', `/campaigns/${ok.body.id}/launch`, {});
    expect(launched.status, JSON.stringify(launched.body)).toBe(200);
    const row = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: ok.body.id, contactId: contact.id } });
    expect(row).toMatchObject({ status: 'PENDING', resolvedParams: { 'BODY.1': 'SAVE10' } });
  });

  it('uses the current value in saved replies and flow messages, and refuses to delete it while they use it', async () => {
    const phone = await create(key('phone'), '+971 4 000 0000');
    const canned = await send(admin, 'post', '/canned-messages', { name: `Call us ${suffix}`, type: 'TEXT', text: `Call us on {global:${phone.key}}` });
    expect(canned.status, JSON.stringify(canned.body)).toBe(201);
    const chat = await inbound(number, uaePhone(), 'hello');
    const reply = () => send(agent, 'post', `/inbox/conversations/${chat.id}/messages`, { type: 'canned', cannedMessageId: canned.body.id });
    expect((await reply()).body).toMatchObject({ kind: 'SESSION_OUT', text: 'Call us on +971 4 000 0000', status: 'QUEUED' });

    // A change is used at once by the api that saved it (its cache is cleared).
    expect((await send(admin, 'put', `/global-attributes/${phone.id}`, { value: '+971 4 111 1111' })).status).toBe(200);
    expect((await reply()).body.text).toBe('Call us on +971 4 111 1111');

    const keyword = `hours${suffix}`;
    const flowId = await publishFlow(keyword, `Call us on {global:${phone.key}} any time`);
    const flowChat = await inbound(number, uaePhone(), keyword);
    expect(await automatic(flowChat)).toContain('Call us on +971 4 111 1111 any time');

    const refused = await send(admin, 'delete', `/global-attributes/${phone.id}`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('GLOBAL_ATTRIBUTE_IN_USE');
    const usage = await admin.agent.get(`/api/global-attributes/${phone.id}/usage`);
    expect(usage.status).toBe(200);
    expect(usage.body.items).toEqual(
      expect.arrayContaining([
        { kind: 'SAVED_REPLY', id: canned.body.id, name: `Call us ${suffix}` },
        { kind: 'FLOW', id: flowId, name: `Hours ${keyword}` },
      ]),
    );
    expect((await agent.agent.get(`/api/global-attributes/${phone.id}/usage`)).status).toBe(403);

    const unused = await create(key('unused'), 'nothing uses me');
    expect((await send(admin, 'delete', `/global-attributes/${unused.id}`)).status).toBe(204);
    expect(await ctx.prisma.globalAttribute.count({ where: { id: unused.id } })).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { targetId: unused.id, action: 'global_attribute.deleted' } })).toBe(1);
  });

  it('puts the value in the AI agent instructions before the request to Claude', async () => {
    const area = await create(key('area'), 'Dubai Marina and JBR');
    const agentId = await publishAgent(`Global agent ${suffix}`, aiNumber.id, { businessDetails: `We deliver in {global:${area.key}} only.` });
    const chat = await inbound(aiNumber, uaePhone(), 'do you deliver to me?');
    let body = '';
    nock(CLAUDE)
      .post('/v1/messages')
      .query(true)
      .reply(async (req: Request) => {
        body = await req.text();
        return [200, claudeReply('Yes, we deliver there.')];
      });
    expect(await ctx.app.get(TurnService).run(chat.id)).toBe('SENT');
    expect(body).toContain('We deliver in Dubai Marina and JBR only.');
    expect(body).not.toContain(`{global:${area.key}}`);

    const usage = await admin.agent.get(`/api/global-attributes/${area.id}/usage`);
    expect(usage.body.items).toEqual([{ kind: 'AI_AGENT', id: agentId, name: `Global agent ${suffix}` }]);
  });
});
