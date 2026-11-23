import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedNumber, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// 003 T037: US3 - flows and people never talk over each other (FR-025–FR-031): hand-over moves the
// chat to Waiting for agent; member actions stop a flow; flows start only in Open chats; STOP,
// "talk to a person" and blocking end a flow; a flow answer replaces the welcome message; members
// start a flow from a chat while the 24-hour window is open.
describe('Chatbot flows: live chat and hand-over (US3)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let admin: SignedInAgent;
  let flowId: string;
  const suffix = randomUUID().replace(/-/g, '').slice(0, 6);
  const keyword = `help${suffix}`;

  const call = (who: SignedInAgent, method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const inbound = async (phone: string, message: Record<string, unknown>) => {
    const from = phone.slice(1);
    const payload = {
      object: 'whatsapp_business_account',
      entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { phone_number_id: number.phoneNumberId }, contacts: [{ wa_id: from }], messages: [{ from, id: `wamid.in.${randomUUID()}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] } }] }],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone }, numberId: number.id } });
  };
  const text = (body: string) => ({ type: 'text', text: { body } });
  const tap = (id: string, title: string) => ({ type: 'interactive', interactive: { type: 'button_reply', button_reply: { id, title } } });
  const automatic = (conversationId: string) =>
    ctx.prisma.chatMessage.findMany({ where: { conversationId, origin: 'AUTOMATIC' }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const sessionsOf = (conversationId: string) => ctx.prisma.flowSession.findMany({ where: { conversationId }, orderBy: { startedAt: 'asc' } });
  const running = async (conversationId: string) => (await sessionsOf(conversationId)).filter((s) => s.status === 'RUNNING');
  /** A new customer whose flow is waiting at the menu. */
  const startFlow = async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, text(keyword));
    const [session] = await running(chat.id);
    expect(session?.currentStepId).toBe('menu');
    return { phone, chat, session: session! };
  };

  const graph = {
    version: 1,
    start: 'menu',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
    steps: [
      { id: 'menu', type: 'buttons', text: 'How can we help?', buttons: [{ key: 'person', title: 'Talk to someone', next: 'handover' }, { key: 'info', title: 'Opening hours', next: 'hours' }] },
      { id: 'handover', type: 'handover', note: 'Asked for a callback from the flow' },
      { id: 'hours', type: 'message', text: 'We open 9 to 6.', next: null },
    ],
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    admin = await signIn(ctx, 'ADMIN');
    const created = await call(manager, 'post', '/flows', { name: `Help desk ${suffix}` });
    flowId = created.body.id;
    expect((await call(manager, 'put', `/flows/${flowId}/draft`, { graph, draftRevision: 0 })).status).toBe(200);
    const published = await call(manager, 'post', `/flows/${flowId}/publish`);
    expect(published.status, JSON.stringify(published.body)).toBe(200);
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('hands over: the chat waits for an agent with the 002 alert and the note, and the session ends HANDED_OVER', async () => {
    const { phone, chat, session } = await startFlow();
    const menu = (await automatic(chat.id))[0]!;
    const buttons = (menu.payload as { buttons: Array<{ id: string; title: string }> }).buttons;
    await inbound(phone, tap(buttons[0]!.id, 'Talk to someone'));

    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: 'ENDED', result: 'HANDED_OVER' });
    expect(await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ state: 'REQUESTING', unresolvedRequests: 1 });
    const requested = await ctx.prisma.conversationEvent.findFirstOrThrow({ where: { conversationId: chat.id, type: 'REQUESTED' } });
    expect(requested).toMatchObject({ actorType: 'FLOW' });
    const note = await ctx.prisma.chatMessage.findFirstOrThrow({ where: { conversationId: chat.id, kind: 'NOTE' } });
    expect(note).toMatchObject({ origin: 'AUTOMATIC', text: 'Asked for a callback from the flow' });
    expect(await ctx.prisma.notification.count({ where: { type: 'INBOX_REQUESTING', link: `/inbox?c=${chat.id}` } })).toBeGreaterThan(0);

    // While the chat waits for an agent, the keyword starts nothing.
    await inbound(phone, text(keyword));
    expect(await running(chat.id)).toHaveLength(0);
  });

  it('stops the flow when a member takes the chat, replies or sends a template; taken chats start nothing', async () => {
    const taken = await startFlow();
    expect((await call(agent, 'post', `/inbox/conversations/${taken.chat.id}/intervene`)).status).toBe(200);
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: taken.session.id } })).toMatchObject({ status: 'ENDED', result: 'STOPPED_BY_MEMBER' });
    await inbound(taken.phone, text(keyword));
    expect(await running(taken.chat.id)).toHaveLength(0);

    const replied = await startFlow();
    expect((await call(agent, 'post', `/inbox/conversations/${replied.chat.id}/messages`, { type: 'text', text: 'Hi, I can help.' })).status).toBe(202);
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: replied.session.id } })).toMatchObject({ status: 'ENDED', result: 'STOPPED_BY_MEMBER' });

    const templated = await startFlow();
    await ctx.prisma.contact.update({ where: { phoneE164: templated.phone }, data: { consentStatus: 'OPTED_IN' } });
    const template = await seedTemplate(ctx, number.wabaId);
    const sent = await call(agent, 'post', `/inbox/conversations/${templated.chat.id}/template`, { templateId: template.id, params: { 'BODY.1': 'Sara' } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: templated.session.id } })).toMatchObject({ status: 'ENDED', result: 'STOPPED_BY_MEMBER' });

    // Closing the chat makes it Open again, and the keyword starts the flow.
    expect((await call(agent, 'post', `/inbox/conversations/${taken.chat.id}/resolve`)).status).toBe(200);
    await inbound(taken.phone, text(keyword));
    expect(await running(taken.chat.id)).toHaveLength(1);
  });

  it('ends the flow on STOP with nothing sent, on "talk to a person", and when the contact is blocked', async () => {
    const stopped = await startFlow();
    const before = (await automatic(stopped.chat.id)).length;
    await inbound(stopped.phone, text('STOP'));
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: stopped.session.id } })).toMatchObject({ status: 'ENDED', result: 'OPTED_OUT' });
    expect((await automatic(stopped.chat.id)).filter((i) => (i.payload as { flow?: unknown }).flow)).toHaveLength(before);

    const human = await startFlow();
    // A keyword of its own: the default list is empty (002) and other files change it in any order.
    const settings = (await call(admin, 'get', '/live-chat/settings')).body;
    expect((await call(admin, 'put', '/live-chat/settings', { ...settings, humanKeywords: ['TALK TO SOMEONE'] })).status).toBe(200);
    try {
      await inbound(human.phone, text('Talk to someone'));
      expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: human.session.id } })).toMatchObject({ status: 'ENDED', result: 'HANDED_OVER' });
      expect((await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: human.chat.id } })).state).toBe('REQUESTING');
    } finally {
      await call(admin, 'put', '/live-chat/settings', settings);
    }

    const blocked = await startFlow();
    expect((await call(manager, 'post', `/contacts/${blocked.chat.contactId}/block`)).status).toBe(204);
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: blocked.session.id } })).toMatchObject({ status: 'ENDED', result: 'BLOCKED' });
    await ctx.prisma.conversation.update({ where: { id: blocked.chat.id }, data: { state: 'ACTIVE', intervenedById: null } });
    await inbound(blocked.phone, text(keyword));
    expect(await running(blocked.chat.id)).toHaveLength(0);
  });

  it('sends no welcome message when a flow answers a new contact', async () => {
    // Live chat settings belong to admins (002).
    const original = (await call(admin, 'get', '/live-chat/settings')).body;
    const put = (body: unknown) => call(admin, 'put', '/live-chat/settings', body as object);
    // Welcome messages go out only within working hours (002), so the test opens every hour of the week.
    const always = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
    expect((await put({ ...original, workingHours: always, welcomeEnabled: true, welcomeContent: { kind: 'TEXT', text: `Welcome ${suffix}!` } })).status).toBe(200);
    try {
      const { chat } = await startFlow();
      const items = await automatic(chat.id);
      expect(items.map((i) => i.text)).toEqual(['How can we help?']);

      const plain = await inbound(uaePhone(), text('Hello there'));
      expect((await automatic(plain.id)).map((i) => i.text)).toEqual([`Welcome ${suffix}!`]);
    } finally {
      await put({ ...original, welcomeEnabled: false });
    }
  });

  it('lets a member start a flow from an open chat, and refuses once the 24-hour window has closed', async () => {
    const phone = uaePhone();
    const chat = await inbound(phone, text('Do you deliver?'));
    const offered = await call(agent, 'get', `/inbox/conversations/${chat.id}/flows`);
    expect(offered.status).toBe(200);
    expect(offered.body).toContainEqual({ id: flowId, name: `Help desk ${suffix}` });

    const started = await call(agent, 'post', `/inbox/conversations/${chat.id}/flows`, { flowId });
    expect(started.status, JSON.stringify(started.body)).toBe(201);
    expect(started.body).toMatchObject({ flowId, flowName: `Help desk ${suffix}`, startedBy: 'MEMBER', stepId: 'menu' });
    const banner = await call(agent, 'get', `/inbox/conversations/${chat.id}/flow-session`);
    expect(banner.body).toMatchObject({ sessionId: started.body.sessionId, startedBy: 'MEMBER' });
    const [session] = await running(chat.id);
    expect(session).toMatchObject({ startedBy: 'MEMBER', startedByUserId: agent.userId });

    await ctx.prisma.conversation.update({ where: { id: chat.id }, data: { lastCustomerMessageAt: new Date(Date.now() - 25 * 3_600_000) } });
    const refused = await call(agent, 'post', `/inbox/conversations/${chat.id}/flows`, { flowId });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('WINDOW_CLOSED');
  });
});
