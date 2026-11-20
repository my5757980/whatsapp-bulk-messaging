import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T089: US8 - internal notes with mentions, openings kept up to date, and the team view
// (FR-038, FR-039, research R14).
describe('Live chat: notes and team view (US8)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let admin: SignedInAgent;
  let agentA: SignedInAgent;
  let originalTimezone: string;

  /** A chat opened by a customer message; returns its ID. */
  const newChat = async (): Promise<string> => {
    const phone = uaePhone();
    const payload = webhook.inbound(number.phoneNumberId, phone.slice(1), `Hello ${randomUUID().slice(0, 4)}`);
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return (await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } })).id;
  };
  const note = (member: SignedInAgent, id: string, body: Record<string, unknown>) =>
    member.agent.post(`/api/inbox/conversations/${id}/notes`).set('X-CSRF-Token', member.csrf).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly(); // any call to the Graph API would fail the test
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    agentA = await signIn(ctx, 'AGENT');
    originalTimezone = (await ctx.prisma.settings.findUniqueOrThrow({ where: { id: 1 } })).defaultTimezone;
  });

  afterAll(async () => {
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { defaultTimezone: originalTimezone } });
    restoreNetwork();
    await ctx.close();
  });

  it('adds team-only notes that are never sent, and alerts mentioned teammates', async () => {
    const id = await newChat();
    const before = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id } });
    // Agent B only sees chats with a tag this contact does not have.
    const agentB = await signIn(ctx, 'AGENT');
    const tag = await ctx.prisma.tag.create({ data: { name: `notes-${randomUUID().slice(0, 6)}` } });
    await ctx.prisma.agentRule.create({ data: { userId: agentB.userId, kind: 'TAG', tagId: tag.id } });

    const res = await note(admin, id, { text: '  Please call this customer back  ', mentions: [agentA.userId, agentA.userId] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ kind: 'NOTE', origin: 'MEMBER', contentType: 'TEXT', text: 'Please call this customer back', status: null, payload: { mentions: [agentA.userId] } });
    expect(res.body.sentBy).toMatchObject({ id: admin.userId });

    // Never sent: nothing queued, no Graph call, and the list order and preview stay as they were.
    expect(await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`session-${res.body.id}`)).toBeUndefined();
    const after = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id } });
    expect(after.lastMessagePreview).toBe(before.lastMessagePreview);
    expect(after.lastActivityAt.getTime()).toBe(before.lastActivityAt.getTime());

    const alert = await ctx.prisma.notification.findFirst({ where: { userId: agentA.userId, type: 'INBOX_MENTION' }, orderBy: { createdAt: 'desc' } });
    expect(alert).toMatchObject({ title: 'You were mentioned', link: `/inbox?c=${id}` });
    expect(await ctx.prisma.notification.count({ where: { userId: admin.userId, type: 'INBOX_MENTION', link: `/inbox?c=${id}` } })).toBe(0);

    const items = await agentA.agent.get(`/api/inbox/conversations/${id}/items`);
    expect(items.status).toBe(200);
    expect(JSON.stringify(items.body)).toContain('Please call this customer back');

    // Mentions must be members who can see the chat; members who cannot see it get a 404.
    const hidden = await note(admin, id, { text: 'FYI', mentions: [agentB.userId] });
    expect(hidden.status).toBe(422);
    expect(hidden.body.details).toContainEqual({ field: 'mentions[0]', issue: 'is not an active member who can see this chat' });
    expect((await note(agentB, id, { text: 'Hi' })).status).toBe(404);
    expect((await note(admin, id, { text: '   ' })).status).toBe(422);
    const members = await admin.agent.get(`/api/inbox/members?conversationId=${id}`);
    expect(members.body.map((m: { id: string }) => m.id)).toContain(agentA.userId);
    expect(members.body.map((m: { id: string }) => m.id)).not.toContain(agentB.userId);
  });

  it('records the first reply by a person, the intervention and the resolution of an opening', async () => {
    const id = await newChat();
    const reply = await agentA.agent.post(`/api/inbox/conversations/${id}/messages`).set('X-CSRF-Token', agentA.csrf).send({ type: 'text', text: 'Hello, how can I help?' });
    expect(reply.status, JSON.stringify(reply.body)).toBe(202);
    let opening = await ctx.prisma.conversationOpening.findFirstOrThrow({ where: { conversationId: id }, orderBy: { openedAt: 'desc' } });
    expect(opening).toMatchObject({ firstResponderId: agentA.userId, intervenedById: agentA.userId, resolvedAt: null });
    expect(opening.firstHumanReplyAt).not.toBeNull();
    expect(opening.intervenedAt).not.toBeNull();

    const resolved = await agentA.agent.post(`/api/inbox/conversations/${id}/resolve`).set('X-CSRF-Token', agentA.csrf);
    expect(resolved.status, JSON.stringify(resolved.body)).toBe(200);
    opening = await ctx.prisma.conversationOpening.findFirstOrThrow({ where: { id: opening.id } });
    expect(opening.resolvedById).toBe(agentA.userId);
    expect(opening.resolvedAt).not.toBeNull();
  });

  it('gives counts and medians per member for today, 7 days and 30 days', async () => {
    // A company time zone where it is about noon now, so "today" safely holds the last 2 hours.
    const offset = 12 - new Date().getUTCHours();
    const zone = offset === 0 ? 'Etc/GMT' : `Etc/GMT${offset > 0 ? '-' : '+'}${Math.abs(offset)}`; // Etc/GMT-5 is UTC+5
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { defaultTimezone: zone } });

    const x = await signIn(ctx, 'AGENT');
    const y = await signIn(ctx, 'MANAGER');
    const conversationId = await newChat();
    const now = Date.now();
    const at = (base: number, seconds: number) => new Date(base + seconds * 1000);
    const opening = (openedAt: number, f: { reply?: [string, number]; take?: [string, number]; close?: [string | null, number] }) =>
      ctx.prisma.conversationOpening.create({
        data: {
          conversationId,
          openedAt: new Date(openedAt),
          ...(f.reply ? { firstResponderId: f.reply[0], firstHumanReplyAt: at(openedAt, f.reply[1]) } : {}),
          ...(f.take ? { intervenedById: f.take[0], intervenedAt: at(openedAt, f.take[1]) } : {}),
          ...(f.close ? { resolvedById: f.close[0], resolvedAt: at(openedAt, f.close[1]) } : {}),
        },
      });
    const minutesAgo = (m: number) => now - m * 60_000;
    // Recent openings (counted in every period). Resolution runs from intervention to resolution.
    await opening(minutesAgo(100), { reply: [x.userId, 60], take: [x.userId, 30], close: [x.userId, 630] }); // first response 60, resolution 600
    await opening(minutesAgo(90), { reply: [x.userId, 120], take: [x.userId, 60], close: [x.userId, 1260] }); // 120, 1200
    await opening(minutesAgo(80), { reply: [x.userId, 300], take: [x.userId, 100] }); // 300, still open
    await opening(minutesAgo(70), { reply: [y.userId, 200], take: [y.userId, 150], close: [y.userId, 1050] }); // Y: 200, 900
    await opening(minutesAgo(60), { take: [x.userId, 10], close: [null, 1800] }); // auto-resolved: closed by nobody
    // Ten days ago: only in the 30-day view.
    await opening(now - 10 * 86_400_000, { reply: [x.userId, 1000], take: [x.userId, 500], close: [x.userId, 5500] }); // 1000, 5000

    const metrics = async (period?: string) => {
      const res = await admin.agent.get(`/api/inbox/team-metrics${period ? `?period=${period}` : ''}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const row = (userId: string) => res.body.members.find((m: { user: { id: string } }) => m.user.id === userId);
      return { body: res.body, x: row(x.userId), y: row(y.userId) };
    };
    const recentX = { intervened: 4, resolved: 2, medianFirstResponseSeconds: 120, medianResolutionSeconds: 900 };
    const recentY = { intervened: 1, resolved: 1, medianFirstResponseSeconds: 200, medianResolutionSeconds: 900 };

    const today = await metrics();
    expect(today.body.period).toBe('today');
    expect(today.x).toMatchObject(recentX);
    expect(today.y).toMatchObject(recentY);
    const week = await metrics('7d');
    expect(week.x).toMatchObject(recentX);
    expect(week.y).toMatchObject(recentY);
    const month = await metrics('30d');
    expect(month.x).toMatchObject({ intervened: 5, resolved: 3, medianFirstResponseSeconds: 210, medianResolutionSeconds: 1200 });
    expect(month.y).toMatchObject(recentY);

    // An idle member is listed with zeros.
    const idle = await signIn(ctx, 'AGENT');
    expect((await metrics('7d')).body.members.find((m: { user: { id: string } }) => m.user.id === idle.userId)).toMatchObject({
      intervened: 0,
      resolved: 0,
      medianFirstResponseSeconds: null,
      medianResolutionSeconds: null,
    });

    // Live counts and the longest wait.
    const waiting = await newChat();
    const requestedAt = new Date(now - 5 * 60_000);
    await ctx.prisma.conversation.update({ where: { id: waiting }, data: { state: 'REQUESTING' } });
    await ctx.prisma.conversationEvent.create({ data: { conversationId: waiting, type: 'REQUESTED', actorType: 'CUSTOMER', occurredAt: requestedAt } });
    const live = (await metrics('today')).body;
    expect(live.live.REQUESTING).toBeGreaterThanOrEqual(1);
    expect(Number.isInteger(live.live.ACTIVE) && Number.isInteger(live.live.INTERVENED)).toBe(true);
    expect(new Date(live.oldestRequestingSince).getTime()).toBeLessThanOrEqual(requestedAt.getTime());
    expect((await admin.agent.get('/api/inbox/team-metrics?period=year')).status).toBe(422);
  });

  it('keeps the team view for admins and managers, who can open any taken chat', async () => {
    expect((await agentA.agent.get('/api/inbox/team-metrics')).status).toBe(403);
    const manager = await signIn(ctx, 'MANAGER');
    expect((await manager.agent.get('/api/inbox/team-metrics')).status).toBe(200);

    const id = await newChat();
    const take = await agentA.agent.post(`/api/inbox/conversations/${id}/intervene`).set('X-CSRF-Token', agentA.csrf);
    expect(take.status).toBe(200);
    expect((await manager.agent.get(`/api/inbox/conversations/${id}`)).status).toBe(200);
    expect((await manager.agent.get(`/api/inbox/conversations/${id}/items`)).status).toBe(200);
  });
});
