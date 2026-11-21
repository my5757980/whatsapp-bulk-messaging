import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { TurnService } from '../../src/modules/ai/turns/turn.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 004 T065: US4 - shared files with a caption, reply buttons and lists whose taps come back to the
// agent, and facts the customer states saved into the allowed attributes (FR-028, FR-029, R12).
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
  usage: { input_tokens: 700, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 },
});

describe('AI agents: rich replies and memory (US4)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let number: { id: string; phoneNumberId: string };
  let agent: { id: string; name: string };
  let priceList: string;
  const suffix = randomUUID().slice(0, 6);

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = manager.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', manager.csrf).send(body ?? {});
  };
  const text = (body: string) => ({ type: 'text', text: { body } });
  const tap = (id: string, title: string) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
  const inbound = async (phone: string, message: Record<string, unknown>) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }],
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
  const aiItems = (chatId: string) => ctx.prisma.chatMessage.findMany({ where: { conversationId: chatId, kind: 'SESSION_OUT', origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
    for (const [key, label, type] of [['city', 'City', 'TEXT'], ['age', 'Age', 'NUMBER']] as const) {
      await ctx.prisma.attributeDefinition.upsert({ where: { key }, create: { key, label, type }, update: {} });
    }
    priceList = (await ctx.prisma.mediaAsset.create({ data: { storageKey: `library/${randomUUID()}.pdf`, mimeType: 'application/pdf', sizeBytes: 40_960, purpose: 'LIBRARY', displayName: 'Price list.pdf' } })).id;
    const created = (await api('post', '/ai-agents', { name: `Rich ${suffix}` })).body;
    agent = { id: created.id, name: created.name };
    const skills = {
      ...created.config.skills,
      buttons: true,
      lists: true,
      media: [{ mediaId: priceList, description: 'Our price list, when someone asks for prices' }],
      memory: [
        { key: 'city', description: "The customer's city" },
        { key: 'age', description: "The customer's age in years" },
      ],
    };
    const saved = await api('put', `/ai-agents/${agent.id}/draft`, { config: { ...created.config, goal: 'Help customers choose furniture.', skills }, draftRevision: 0 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const published = await api('post', `/ai-agents/${agent.id}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect((await api('put', `/ai-agents/${agent.id}/numbers`, { numberIds: [number.id] })).status).toBe(200);
  });

  afterEach(() => nock.cleanAll());

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('sends a shared file with the message as its caption', async () => {
    const chat = await inbound(uaePhone(), text('can you send me the price list?'));
    const sent = claude({ message: 'Here is our price list.', mediaId: priceList });
    expect(await turn(chat.id)).toBe('SENT');
    expect(sent()).toContain('Our price list, when someone asks for prices');
    const [item, ...more] = await aiItems(chat.id);
    expect(more).toHaveLength(0);
    expect(item).toMatchObject({ contentType: 'DOCUMENT', mediaAssetId: priceList, text: `Hi, I'm ${agent.name}, a virtual assistant.\n\nHere is our price list.` });
    expect(item!.payload).toMatchObject({ fileName: 'Price list.pdf', mimeType: 'application/pdf', ai: { agentId: agent.id } });
    expect(await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`session-${item!.id}`)).toBeTruthy();
  });

  it('sends reply buttons and lists, and a tap comes back to the agent as the customer answer', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, text('I need a sofa'));
    claude({ message: 'Which size do you need?', buttons: ['Small', 'Large'] });
    expect(await turn(chat.id)).toBe('SENT');
    const [buttons] = await aiItems(chat.id);
    const conversation = await ctx.prisma.aiConversation.findFirstOrThrow({ where: { conversationId: chat.id } });
    expect(buttons).toMatchObject({ contentType: 'BUTTONS' });
    expect(buttons!.payload).toMatchObject({
      buttons: [
        { id: `ai:${conversation.id}:1`, title: 'Small' },
        { id: `ai:${conversation.id}:2`, title: 'Large' },
      ],
    });

    await inbound(phone, tap(`ai:${conversation.id}:2`, 'Large'));
    const answer = claude({ message: 'Which colour?', list: { button: 'Colours', rows: ['Grey', 'Blue', 'Green', 'Sand'].map((title) => ({ title, description: null })) } });
    expect(await turn(chat.id)).toBe('SENT');
    expect(answer()).toContain('Large');
    const list = (await aiItems(chat.id)).at(-1)!;
    expect(list).toMatchObject({ contentType: 'LIST', text: 'Which colour?' });
    const rows = (list.payload as { sections: Array<{ rows: Array<{ id: string; title: string }> }> }).sections[0]!.rows;
    expect(list.payload).toMatchObject({ buttonLabel: 'Colours' });
    expect(rows.map((r) => r.title)).toEqual(['Grey', 'Blue', 'Green', 'Sand']);
    expect(rows[3]!.id).toBe(`ai:${conversation.id}:4`);
  });

  it('saves facts the customer states into the allowed attributes, with a journey entry by the agent', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, text('I live in Al Ain and I am forty'));
    claude({
      message: 'Thanks! We deliver to Al Ain.',
      remember: [
        { key: 'city', value: 'Al Ain' },
        { key: 'age', value: 'forty' },
        { key: 'vip', value: 'yes' },
      ],
    });
    expect(await turn(chat.id)).toBe('SENT');
    const contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } });
    expect(contact.attributes).toEqual({ city: 'Al Ain' });
    const entry = await ctx.prisma.conversationEvent.findFirstOrThrow({ where: { conversationId: chat.id, type: 'ATTRIBUTE_CHANGED' } });
    expect(entry).toMatchObject({ actorType: 'AI_AGENT' });
    expect(entry.data).toMatchObject({ key: 'city', from: null, to: 'Al Ain', agentId: agent.id, agentName: agent.name });
  });

  it('masks a card number in the request to the AI service and never saves it', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, text('my card is 4111 1111 1111 1111, can I pay with it?'));
    const sent = claude({ message: 'Please do not share card numbers here. You can pay on delivery.', remember: [{ key: 'city', value: '4111111111111111' }] });
    expect(await turn(chat.id)).toBe('SENT');
    expect(sent()).toContain('[card number removed]');
    expect(sent()).not.toContain('4111 1111 1111 1111');
    expect(sent()).not.toContain('4111111111111111');
    expect((await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } })).attributes).toEqual({});
  });
});
