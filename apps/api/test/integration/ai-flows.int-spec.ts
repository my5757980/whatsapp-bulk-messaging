import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TurnService } from '../../src/modules/ai/turns/turn.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T079: US6 - flows and agents take turns (FR-032, FR-033, research R9): flow triggers come
// first, a flow can hand the chat to an agent, and an agent can start a flow and continue after it.
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
  usage: { input_tokens: 600, output_tokens: 40, cache_read_input_tokens: 900, cache_creation_input_tokens: 0 },
});

describe('AI agents: working with chatbot flows (US6)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let number: { id: string; phoneNumberId: string };
  let sara: { id: string; name: string; config: Record<string, unknown> };
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
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
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
  const turn = (chatId: string) => ctx.app.get(TurnService).run(chatId);
  const automatic = (chatId: string) => ctx.prisma.chatMessage.findMany({ where: { conversationId: chatId, origin: 'AUTOMATIC', kind: 'SESSION_OUT' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const sessions = (chatId: string) => ctx.prisma.flowSession.findMany({ where: { conversationId: chatId }, orderBy: { startedAt: 'asc' } });
  const makeAgent = async (name: string, goal: string, patch: Record<string, unknown> = {}) => {
    const created = (await api('post', '/ai-agents', { name })).body;
    const saved = await api('put', `/ai-agents/${created.id}/draft`, { config: { ...created.config, goal, ...patch }, draftRevision: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    return { id: created.id as string, name, config: created.config as Record<string, unknown> };
  };
  const makeFlow = async (name: string, graph: Record<string, unknown>, publish = true) => {
    const flow = (await api('post', '/flows', { name })).body;
    expect((await api('put', `/flows/${flow.id}/draft`, { graph: { version: 1, ...graph }, draftRevision: 0 })).status).toBe(200);
    if (publish) {
      const published = await api('post', `/flows/${flow.id}/publish`);
      expect(published.status, JSON.stringify(published.body)).toBe(200);
    }
    return flow.id as string;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
    sara = await makeAgent(`Sara ${suffix}`, `Sara answers shop questions ${suffix}.`);
    expect((await api('post', `/ai-agents/${sara.id}/publish`)).status).toBe(200);
    expect((await api('put', `/ai-agents/${sara.id}/numbers`, { numberIds: [number.id] })).status).toBe(200);
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('lets a flow keyword win, and the agent answers after the flow ends', async () => {
    const keyword = `menu${suffix}`;
    await makeFlow(`Menu ${suffix}`, {
      start: 'hi',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword] }],
      steps: [{ id: 'hi', type: 'message', text: `Our menu ${suffix}`, next: null }],
    });
    const phone = uaePhone();
    const chat = await inbound(phone, keyword);
    expect((await automatic(chat.id)).map((i) => i.text)).toEqual([`Our menu ${suffix}`]);
    expect(await ctx.prisma.chatMessage.count({ where: { conversationId: chat.id, aiPending: true } })).toBe(0);

    await inbound(phone, 'and what are your opening hours?');
    claude({ message: 'We open at 9.' });
    expect(await turn(chat.id)).toBe('SENT');
    expect((await automatic(chat.id)).at(-1)?.text).toContain('We open at 9.');
  });

  it("hands the chat from a flow to an agent that is not the number's agent", async () => {
    const omar = await makeAgent(`Omar ${suffix}`, `Omar handles returns ${suffix}.`);
    expect((await api('post', `/ai-agents/${omar.id}/publish`)).status).toBe(200);
    const keyword = `returns${suffix}`;
    await makeFlow(`Returns ${suffix}`, {
      start: 'hi',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword] }],
      steps: [
        { id: 'hi', type: 'message', text: 'Sorry to hear that.', next: 'ai' },
        { id: 'ai', type: 'aiAgent', agentId: omar.id, openingMessage: 'Our returns assistant will help you now.' },
      ],
    });
    const phone = uaePhone();
    const chat = await inbound(phone, keyword);
    expect((await automatic(chat.id)).map((i) => i.text)).toEqual(['Sorry to hear that.', 'Our returns assistant will help you now.']);
    expect(await sessions(chat.id)).toMatchObject([{ status: 'ENDED', result: 'HANDED_TO_AI' }]);
    expect(await ctx.prisma.aiConversation.findFirstOrThrow({ where: { conversationId: chat.id } })).toMatchObject({ agentId: omar.id, startedBy: 'FLOW', status: 'ACTIVE' });

    await inbound(phone, 'I want to return a chair');
    const sent = claude({ message: 'I can help with your return.' });
    expect(await turn(chat.id)).toBe('SENT');
    expect(sent()).toContain(`Omar handles returns ${suffix}.`);
    const reply = (await automatic(chat.id)).at(-1)!;
    expect(reply.payload).toMatchObject({ ai: { agentId: omar.id } });
    expect(reply.text).toBe(`Hi, I'm ${omar.name}, a virtual assistant.\n\nI can help with your return.`);
  });

  it('starts a flow from the agent (startedBy AI_AGENT), and the same agent continues after it', async () => {
    const book = await makeFlow(`Book a visit ${suffix}`, {
      start: 'day',
      triggers: [],
      steps: [
        { id: 'day', type: 'question', text: 'Which day suits you?', answer: { kind: 'text' }, answerName: 'day', retryText: 'Please tell me a day.', next: 'done' },
        { id: 'done', type: 'message', text: 'Booked for {answer:day}.', next: null },
      ],
    });
    const current = (await api('get', `/ai-agents/${sara.id}`)).body;
    const skills = { ...current.config.skills, flows: [{ flowId: book, whenToUse: 'When the customer wants to book a showroom visit' }] };
    expect((await api('put', `/ai-agents/${sara.id}/draft`, { config: { ...current.config, skills }, draftRevision: current.draftRevision })).status).toBe(200);
    expect((await api('post', `/ai-agents/${sara.id}/publish`)).status).toBe(200);

    const phone = uaePhone();
    const chat = await inbound(phone, 'I would like to book a visit');
    const first = claude({ message: 'Sure, let us find a day.', startFlow: book });
    expect(await turn(chat.id)).toBe('SENT');
    expect(first()).toContain('When the customer wants to book a showroom visit');
    expect((await automatic(chat.id)).map((i) => i.text)).toEqual([`Hi, I'm ${sara.name}, a virtual assistant.\n\nSure, let us find a day.`, 'Which day suits you?']);
    expect(await sessions(chat.id)).toMatchObject([{ status: 'RUNNING', startedBy: 'AI_AGENT', flowId: book }]);

    // While the flow runs it answers; the agent waits.
    await inbound(phone, 'Monday');
    expect(await sessions(chat.id)).toMatchObject([{ status: 'ENDED', result: 'COMPLETED' }]);
    expect((await automatic(chat.id)).at(-1)?.text).toBe('Booked for Monday.');
    expect(await ctx.prisma.chatMessage.count({ where: { conversationId: chat.id, aiPending: true } })).toBe(0);

    // After it, the same AI conversation continues, without a second introduction.
    await inbound(phone, 'Thanks! Where is the showroom?');
    claude({ message: 'Our showroom is in Al Quoz.' });
    expect(await turn(chat.id)).toBe('SENT');
    expect((await automatic(chat.id)).at(-1)?.text).toBe('Our showroom is in Al Quoz.');
    expect(await ctx.prisma.aiConversation.findMany({ where: { conversationId: chat.id } })).toMatchObject([{ status: 'ACTIVE', replies: 2 }]);
  });

  it('refuses to publish a flow whose agent is not published, and an agent whose flow is not published', async () => {
    const draftAgent = await makeAgent(`Draft ${suffix}`, 'Not ready yet.');
    const flow = await makeFlow(
      `To draft agent ${suffix}`,
      { start: 'ai', triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`draft${suffix}`] }], steps: [{ id: 'ai', type: 'aiAgent', agentId: draftAgent.id }] },
      false,
    );
    const blocked = await api('post', `/flows/${flow}/publish`);
    expect(blocked.status).toBe(422);
    expect(blocked.body.problems).toContainEqual(expect.objectContaining({ code: 'AGENT_NOT_PUBLISHED', stepId: 'ai', field: 'agentId' }));

    const unpublished = await makeFlow(`Unpublished ${suffix}`, { start: 'hi', triggers: [], steps: [{ id: 'hi', type: 'message', text: 'Hi', next: null }] }, false);
    const agent = await makeAgent(`Flowy ${suffix}`, 'Starts flows.');
    const current = (await api('get', `/ai-agents/${agent.id}`)).body;
    const skills = { ...current.config.skills, flows: [{ flowId: unpublished, whenToUse: 'Never' }] };
    expect((await api('put', `/ai-agents/${agent.id}/draft`, { config: { ...current.config, skills }, draftRevision: current.draftRevision })).status).toBe(200);
    const refused = await api('post', `/ai-agents/${agent.id}/publish`);
    expect(refused.status).toBe(422);
    expect(refused.body.problems.map((p: { code: string }) => p.code)).toContain('FLOW_NOT_PUBLISHED');
  });
});
