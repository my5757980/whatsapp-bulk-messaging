import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutoResolveProcessor } from '../../src/modules/inbox/routing/auto-resolve.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T045: US3 - "talk to a person" keywords, transfer, auto-resolve, agent rules, filters and
// deactivation (FR-021-FR-028, SC-008, research R5-R7, R13).
describe('Live chat: routing (US3)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agentA: SignedInAgent;
  let agentB: SignedInAgent;

  const inbound = async (phone: string, text: string) =>
    ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), text)));
  const chatOf = (phone: string) => ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
  const newChat = async (text = 'hello') => {
    const phone = uaePhone();
    await inbound(phone, text);
    return { phone, chat: await chatOf(phone) };
  };
  const post = (who: SignedInAgent, path: string) => who.agent.post(path).set('X-CSRF-Token', who.csrf);
  const put = (who: SignedInAgent, path: string) => who.agent.put(path).set('X-CSRF-Token', who.csrf);

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agentA = await signIn(ctx, 'AGENT');
    agentB = await signIn(ctx, 'AGENT');
    const settings = await admin.agent.get('/api/live-chat/settings');
    expect(settings.status).toBe(200);
    const saved = await put(admin, '/api/live-chat/settings').send({ ...settings.body, humanKeywords: ['agent', ' Talk  to human '], autoResolve: false });
    expect(saved.status).toBe(200);
    expect(saved.body.humanKeywords).toEqual(['AGENT', 'TALK TO HUMAN']);
  });

  afterAll(async () => ctx.close());

  it('moves a chat to Waiting for agent on a "talk to a person" keyword and alerts who can see it', async () => {
    const { phone, chat } = await newChat('hi');
    await inbound(phone, '  talk to   HUMAN ');
    expect(await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ state: 'REQUESTING', unresolvedRequests: 1 });
    const journey = await ctx.prisma.conversationEvent.findMany({ where: { conversationId: chat.id } });
    expect(journey.map((e) => e.type)).toContain('REQUESTED');
    for (const member of [admin, manager, agentA]) {
      expect(await ctx.prisma.notification.count({ where: { userId: member.userId, type: 'INBOX_REQUESTING', link: `/inbox?c=${chat.id}` } })).toBe(1);
    }
  });

  it('only counts a keyword in a chat someone has taken', async () => {
    const { phone, chat } = await newChat();
    expect((await post(agentA, `/api/inbox/conversations/${chat.id}/intervene`)).status).toBe(200);
    await inbound(phone, 'AGENT');
    expect(await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({
      state: 'INTERVENED',
      intervenedById: agentA.userId,
      unresolvedRequests: 1,
    });
  });

  it('transfers a taken chat to another member, who is notified', async () => {
    const { chat } = await newChat();
    expect((await post(agentA, `/api/inbox/conversations/${chat.id}/intervene`)).status).toBe(200);
    // Agent B cannot see a chat agent A took, so cannot transfer it either.
    expect((await post(agentB, `/api/inbox/conversations/${chat.id}/transfer`).send({ userId: agentB.userId })).status).toBe(404);

    const moved = await post(agentA, `/api/inbox/conversations/${chat.id}/transfer`).send({ userId: agentB.userId });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ state: 'INTERVENED', intervenedBy: { id: agentB.userId } });
    expect((await agentA.agent.get(`/api/inbox/conversations/${chat.id}`)).status).toBe(404);
    expect((await agentB.agent.get(`/api/inbox/conversations/${chat.id}`)).status).toBe(200);
    expect(await ctx.prisma.notification.count({ where: { userId: agentB.userId, type: 'INBOX_TRANSFERRED' } })).toBeGreaterThanOrEqual(1);
    const event = await ctx.prisma.conversationEvent.findFirstOrThrow({ where: { conversationId: chat.id, type: 'TRANSFERRED' } });
    expect(event.data).toMatchObject({ fromUserId: agentA.userId, toUserId: agentB.userId });

    // Managers can move any taken chat.
    expect((await post(manager, `/api/inbox/conversations/${chat.id}/transfer`).send({ userId: agentA.userId })).status).toBe(200);
  });

  it('refuses a transfer to an agent whose rules exclude the chat', async () => {
    const tag = await ctx.prisma.tag.create({ data: { name: `vip-${randomUUID().slice(0, 6)}` } });
    const restricted = await signIn(ctx, 'AGENT');
    expect((await put(admin, `/api/users/${restricted.userId}/agent-rules`).send([{ kind: 'TAG', tagId: tag.id }])).status).toBe(200);
    const { chat } = await newChat();
    await post(manager, `/api/inbox/conversations/${chat.id}/intervene`);
    const res = await post(manager, `/api/inbox/conversations/${chat.id}/transfer`).send({ userId: restricted.userId });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('TARGET_CANNOT_SEE');
  });

  it('closes quiet taken chats after 24 hours only when auto-resolve is on', async () => {
    const { chat } = await newChat();
    await post(agentA, `/api/inbox/conversations/${chat.id}/intervene`);
    await ctx.prisma.conversation.update({ where: { id: chat.id }, data: { lastActivityAt: new Date(Date.now() - 25 * 3_600_000) } });

    await ctx.app.get(AutoResolveProcessor).run();
    expect((await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).state).toBe('INTERVENED');

    const settings = (await admin.agent.get('/api/live-chat/settings')).body as Record<string, unknown>;
    await put(admin, '/api/live-chat/settings').send({ ...settings, autoResolve: true });
    await ctx.app.get(AutoResolveProcessor).run();
    expect(await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ state: 'ACTIVE', intervenedById: null });
    const auto = await ctx.prisma.conversationEvent.findFirstOrThrow({ where: { conversationId: chat.id, type: 'AUTO_RESOLVED' } });
    expect(auto).toMatchObject({ actorType: 'SYSTEM', actorUserId: null });
    await put(admin, '/api/live-chat/settings').send({ ...settings, autoResolve: false });
  });

  it('shows a rule-limited agent exactly the matching chats (SC-008)', async () => {
    const demo = await ctx.prisma.tag.create({ data: { name: `demo-${randomUUID().slice(0, 6)}` } });
    await ctx.prisma.attributeDefinition.upsert({ where: { key: 'branch' }, create: { key: 'branch', label: 'Branch', type: 'TEXT' }, update: {} });
    const agent = await signIn(ctx, 'AGENT');
    const rules = await put(admin, `/api/users/${agent.userId}/agent-rules`).send([
      { kind: 'TAG', tagId: demo.id },
      { kind: 'ATTRIBUTE', attributeKey: 'branch', attributeValue: 'Marina' },
      { kind: 'TAG', tagId: demo.id }, // duplicates are dropped
    ]);
    expect(rules.status).toBe(200);
    expect(rules.body).toHaveLength(2);

    const expected = new Set<string>();
    for (let i = 0; i < 12; i++) {
      const phone = uaePhone();
      const contact = await seedContact(ctx, phone, {
        attributes: i % 3 === 0 ? { branch: 'Marina' } : i % 3 === 1 ? { branch: 'Deira' } : {},
        ...(i % 4 === 0 ? { tags: { create: [{ tagId: demo.id }] } } : {}),
      });
      await inbound(phone, `chat ${i}`);
      const chat = await ctx.prisma.conversation.findFirstOrThrow({ where: { contactId: contact.id } });
      if (i % 3 === 0 || i % 4 === 0) expected.add(chat.id);
    }
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const res = await agent.agent.get('/api/inbox/conversations').query({ limit: 100, ...(cursor ? { cursor } : {}) });
      for (const c of res.body.items as Array<{ id: string }>) seen.add(c.id);
      cursor = res.body.nextCursor ?? undefined;
    } while (cursor);
    // Only the 12 chats above can match these rules, so the agent sees exactly the expected ones.
    expect([...seen].sort()).toEqual([...expected].sort());
  });

  it('combines tag, attribute and campaign filters', async () => {
    const tag = await ctx.prisma.tag.create({ data: { name: `filter-${randomUUID().slice(0, 6)}` } });
    const template = await seedTemplate(ctx, number.wabaId);
    const phones = [uaePhone(), uaePhone(), uaePhone()];
    const contacts = [
      await seedContact(ctx, phones[0]!, { attributes: { city: 'Dubai' }, tags: { create: [{ tagId: tag.id }] } }),
      await seedContact(ctx, phones[1]!, { attributes: { city: 'Dubai' } }),
      await seedContact(ctx, phones[2]!, { tags: { create: [{ tagId: tag.id }] } }),
    ];
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contacts[0]!, contacts[2]!] });
    for (const phone of phones) await inbound(phone, 'hi');
    const ids = async (query: Record<string, string>) =>
      ((await admin.agent.get('/api/inbox/conversations').query({ limit: 100, ...query })).body.items as Array<{ contactId: string }>).map((c) => c.contactId).sort();

    expect(await ids({ tagId: tag.id })).toEqual([contacts[0]!.id, contacts[2]!.id].sort());
    expect(await ids({ tagId: tag.id, attribute: 'city:Dubai' })).toEqual([contacts[0]!.id]);
    expect(await ids({ campaignId: campaign.id, attribute: 'city:Dubai' })).toEqual([contacts[0]!.id]);
    expect(await ids({ campaignId: campaign.id })).toEqual([contacts[0]!.id, contacts[2]!.id].sort());
  });

  it('returns a deactivated member’s chats to Open', async () => {
    const leaver = await signIn(ctx, 'AGENT');
    const { chat } = await newChat();
    await post(leaver, `/api/inbox/conversations/${chat.id}/intervene`);
    const res = await admin.agent.patch(`/api/users/${leaver.userId}`).set('X-CSRF-Token', admin.csrf).send({ status: 'DEACTIVATED' });
    expect(res.status).toBe(200);
    expect(await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ state: 'ACTIVE', intervenedById: null });
    expect(await ctx.prisma.conversationEvent.count({ where: { conversationId: chat.id, type: 'AUTO_RESOLVED' } })).toBe(1);
  });

  it('validates the settings and agent rules', async () => {
    const settings = (await admin.agent.get('/api/live-chat/settings')).body as Record<string, unknown>;
    const tooMany = await put(admin, '/api/live-chat/settings').send({ ...settings, humanKeywords: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(tooMany.status).toBe(422);
    expect((await agentA.agent.get('/api/live-chat/settings')).status).toBe(403);
    expect((await put(admin, `/api/users/${manager.userId}/agent-rules`).send([])).body.code).toBe('NOT_AN_AGENT');
    expect((await put(admin, `/api/users/${agentA.userId}/agent-rules`).send([{ kind: 'ATTRIBUTE', attributeKey: 'no_such_key', attributeValue: 'x' }])).status).toBe(422);
  });
});
