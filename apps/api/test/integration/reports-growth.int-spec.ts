import { randomInt } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedContact, seedNumber, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T059 (feature 009 US5, research R14): the overview, team member and opt-in reports with their CSV
// downloads. The data sits on a day months ago that no other test uses, on its own number.
const HOUR = 3_600_000;

describe('Reports (009 US5)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let leaver: SignedInAgent;
  let agent: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let day: string;
  let noon: Date;

  const get = (who: SignedInAgent, url: string) => who.agent.get(`/api${url}`);
  const range = () => `from=${day}&to=${day}`;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    leaver = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    number = await seedNumber(ctx);
    // A day 150 - 300 days ago, at noon UTC so it is the same date in any company time zone.
    noon = new Date(Date.now() - randomInt(150, 300) * 24 * HOUR);
    noon.setUTCHours(12, 0, 0, 0);
    day = noon.toISOString().slice(0, 10);

    const marketing = await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' });
    const utility = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' });
    const campaign = async (templateId: string, launchedById: string) =>
      ctx.prisma.campaign.create({ data: { name: `Report ${digits(5)}`, numberId: number.id, templateId, state: 'COMPLETED', audienceType: 'ALL_OPTED_IN', variableMapping: {}, launchedAt: noon, launchedById, createdById: launchedById } });
    const byManager = await campaign(marketing.id, manager.userId);
    const byLeaver = await campaign(utility.id, leaver.userId);
    // [campaign, template, status, extra]
    const rows = [
      [byManager, marketing, 'READ', { deliveredAt: noon, readAt: noon, costUsdMicros: 25_000n }],
      [byManager, marketing, 'DELIVERED', { deliveredAt: noon, costUsdMicros: 25_000n }],
      [byManager, marketing, 'FAILED', { failureCode: 131049, failureReason: 'Held back by the per-person limit' }],
      [byManager, marketing, 'EXPIRED', { expiredReason: 'NOT_DELIVERED_IN_TIME' }],
      [byLeaver, utility, 'SENT', {}],
      [byLeaver, utility, 'FAILED', { failureCode: 131026, failureReason: 'Message undeliverable' }],
    ] as const;
    for (const [c, t, status, extra] of rows) {
      const contact = await seedContact(ctx, uaePhone());
      const message = await ctx.prisma.message.create({
        data: { origin: 'CAMPAIGN', campaignId: c.id, contactId: contact.id, phoneE164: contact.phoneE164, recipientCountry: 'AE', numberId: number.id, templateId: t.id, status, sentAt: noon, createdAt: noon, ...extra },
      });
      // The first reader replied an hour later.
      if (status === 'READ') {
        const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id, state: 'ACTIVE', lastCustomerMessageAt: new Date(noon.getTime() + HOUR) } });
        await ctx.prisma.chatMessage.create({ data: { conversationId: chat.id, kind: 'INBOUND', origin: 'CUSTOMER', contentType: 'TEXT', text: 'Yes please', occurredAt: new Date(noon.getTime() + HOUR) } });
        // Live chat that day: the manager took it, answered after 90 seconds and closed it.
        await ctx.prisma.conversationOpening.create({
          data: { conversationId: chat.id, openedAt: noon, firstHumanReplyAt: new Date(noon.getTime() + 90_000), firstResponderId: manager.userId, intervenedAt: noon, intervenedById: manager.userId, resolvedAt: new Date(noon.getTime() + HOUR), resolvedById: manager.userId },
        });
        await ctx.prisma.chatMessage.create({ data: { conversationId: chat.id, kind: 'SESSION_OUT', origin: 'MEMBER', contentType: 'TEXT', text: 'Done!', occurredAt: new Date(noon.getTime() + 90_000), sentByUserId: manager.userId, status: 'SENT' } });
      }
      void message;
    }
    // The second launcher has left; their campaign still counts for them.
    await ctx.prisma.user.update({ where: { id: leaver.userId }, data: { status: 'DEACTIVATED' } });

    // Opt-ins and opt-outs that day.
    const consent = [
      ['OPTED_IN', 'IMPORT', null, null],
      ['OPTED_OUT', 'KEYWORD', 'STOP', null],
      ['OPTED_IN', 'MANUAL', 'Asked at the counter', manager.userId],
    ] as const;
    for (const [status, source, note, actorUserId] of consent) {
      const contact = await seedContact(ctx, uaePhone(), { name: `Consent ${source}` });
      await ctx.prisma.consentEvent.create({ data: { contactId: contact.id, status, source, note, actorUserId, createdAt: noon } });
    }
  });
  afterAll(async () => ctx.close());

  it('sums the day by category and number, with failures by reason, expired, replied and the cost', async () => {
    const res = await get(manager, `/reports/overview?${range()}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const mine = (res.body.byNumber as Array<Record<string, unknown>>).find((n) => n.numberId === number.id);
    expect(mine).toMatchObject({ label: number.label, sent: 3, delivered: 2, read: 1, replied: 1, clicked: 0, failed: 2, expired: 1, estimatedCostUsd: '0.050000' });
    const day0 = (res.body.days as Array<Record<string, unknown>>).find((d) => d.day === day);
    expect(day0).toMatchObject({ sent: expect.any(Number) });
    expect(Number(day0!.sent)).toBeGreaterThanOrEqual(3);
    const categories = Object.fromEntries((res.body.byCategory as Array<{ category: string; sent: number; failed: number }>).map((c) => [c.category, c]));
    expect(categories.MARKETING!.failed).toBeGreaterThanOrEqual(1);
    expect(categories.UTILITY!.sent).toBeGreaterThanOrEqual(1);
    const reasons = Object.fromEntries((res.body.failedByReason as Array<{ code: number; count: number }>).map((r) => [r.code, r.count]));
    expect(reasons[131049]).toBeGreaterThanOrEqual(1);
    expect(reasons[131026]).toBeGreaterThanOrEqual(1);

    // The CSV has the same numbers, one row per day, category and number.
    const csv = await get(manager, `/reports/overview.csv?${range()}`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = String(csv.text).trim().split('\n');
    expect(lines[0]).toBe('day,category,number,sent,delivered,read,replied,clicked,failed,expired,estimated_cost_usd');
    const ours = lines.filter((l) => l.includes(number.label));
    expect(ours.map((l) => l.split(',').slice(1, 2)[0]).sort()).toEqual(['MARKETING', 'UTILITY']);
    const marketingRow = ours.find((l) => l.includes('MARKETING'))!.split(',');
    expect(marketingRow.slice(3)).toEqual(['2', '2', '1', '1', '0', '1', '1', '0.050000']);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'data.exported', actorUserId: manager.userId, targetType: 'report', metadata: { path: ['report'], equals: 'overview' } } })).toBeGreaterThanOrEqual(1);
  });

  it('lists each member with campaigns launched (removed members too) and live chat figures', async () => {
    const res = await get(admin, `/reports/team?${range()}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const members = new Map((res.body.members as Array<Record<string, unknown> & { userId: string }>).map((m) => [m.userId, m]));
    expect(members.get(manager.userId)).toMatchObject({
      active: true,
      campaignsLaunched: 1,
      campaignTotals: { sent: 2, delivered: 2, read: 1, replied: 1, failed: 1, expired: 1, estimatedCostUsd: '0.050000' },
      chatsTaken: 1,
      chatsClosed: 1,
      repliesSent: 1,
      medianFirstResponseSeconds: 90,
    });
    expect(members.get(leaver.userId)).toMatchObject({ active: false, campaignsLaunched: 1, campaignTotals: { sent: 1, failed: 1 } });

    const csv = await get(admin, `/reports/team.csv?${range()}`);
    expect(csv.status).toBe(200);
    expect(String(csv.text).split('\n')[0]).toBe('name,active,campaigns_launched,sent,delivered,read,replied,clicked,failed,expired,estimated_cost_usd,chats_taken,chats_closed,replies_sent,median_first_response_seconds');
  });

  it('lists each opt-in and opt-out with its source, counted by day and source, page by page', async () => {
    const res = await get(manager, `/reports/consent?${range()}&pageSize=2`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.total).toBeGreaterThanOrEqual(3);
    expect(res.body.items).toHaveLength(2);
    const counts = Object.fromEntries((res.body.counts as Array<{ day: string; source: string; optedIn: number; optedOut: number }>).filter((c) => c.day === day).map((c) => [c.source, [c.optedIn, c.optedOut]]));
    expect(counts.KEYWORD![1]).toBeGreaterThanOrEqual(1);
    expect(counts.MANUAL![0]).toBeGreaterThanOrEqual(1);
    const outs = await get(manager, `/reports/consent?${range()}&status=OPTED_OUT`);
    const stop = (outs.body.items as Array<Record<string, unknown>>).find((i) => i.name === 'Consent KEYWORD');
    expect(stop).toMatchObject({ status: 'OPTED_OUT', source: 'KEYWORD', note: 'STOP', actor: null });
    const all = await get(manager, `/reports/consent?${range()}&pageSize=200`);
    const manual = (all.body.items as Array<Record<string, unknown>>).find((i) => i.name === 'Consent MANUAL');
    expect(manual).toMatchObject({ status: 'OPTED_IN', note: 'Asked at the counter', actor: expect.any(String) });
    // Managers see full numbers; roles without phones.full get them masked by the global interceptor.
    expect(String(manual!.phone)).toMatch(/^\+971/);

    const csv = await get(manager, `/reports/consent.csv?${range()}`);
    expect(csv.status).toBe(200);
    const lines = String(csv.text).trim().split('\n');
    expect(lines[0]).toBe('at,name,phone,status,source,note,actor');
    expect(lines.filter((l) => l.includes('Consent ')).length).toBeGreaterThanOrEqual(3);
  });

  it('refuses bad ranges with RANGE_INVALID, and agents cannot see reports', async () => {
    const bad = async (query: string) => {
      const res = await get(manager, `/reports/overview?${query}`);
      expect(res.status, query).toBe(422);
      expect(res.body.code).toBe('RANGE_INVALID');
    };
    await bad('from=2026-11-10&to=2026-11-01');
    await bad(`from=${new Date(Date.now() - 500 * 24 * HOUR).toISOString().slice(0, 10)}&to=${new Date().toISOString().slice(0, 10)}`);
    await bad('from=2020-01-01&to=2020-01-02');
    await bad('from=nope&to=2026-11-01');
    expect((await get(agent, `/reports/overview?${range()}`)).status).toBe(403);
    expect((await get(agent, `/reports/consent.csv?${range()}`)).status).toBe(403);
  });
});
