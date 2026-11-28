import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T154: campaign report and recipient export (FR-028, FR-030).
describe('Campaign report and export', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let campaignId: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    const admin2 = admin;
    await ctx.prisma.rateCardEntry.deleteMany({});
    await ctx.prisma.rateCardEntry.createMany({
      data: [
        { category: 'UTILITY', countryCode: '*', priceUsdMicros: 10_000n, effectiveFrom: new Date('2026-01-01') },
        { category: 'MARKETING', countryCode: 'AE', priceUsdMicros: 40_000n, effectiveFrom: new Date('2026-01-01') },
      ],
    });
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' });
    const contacts = [];
    for (let i = 0; i < 6; i++) contacts.push(await seedContact(ctx, uaePhone(), { name: `Report ${i}` }));
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin2.userId, contacts });
    campaignId = campaign.id;
    const messages = await ctx.prisma.message.findMany({ where: { campaignId }, orderBy: { id: 'asc' } });
    const at = new Date('2026-11-10T10:00:00Z');
    const set = (i: number, data: Record<string, unknown>) => ctx.prisma.message.update({ where: { id: messages[i]!.id }, data });
    await set(0, { status: 'READ', sentAt: at, deliveredAt: at, readAt: at, billable: true, pricingCategory: 'marketing' });
    await set(1, { status: 'READ', sentAt: at, deliveredAt: at, readAt: at });
    await set(2, { status: 'DELIVERED', sentAt: at, deliveredAt: at });
    await set(3, { status: 'SENT', sentAt: at });
    await set(4, { status: 'FAILED', failedAt: at, failureCode: 131026, failureReason: 'Message undeliverable' });
    await set(5, { status: 'SKIPPED', skipReason: 'OPTED_OUT' });
    await ctx.prisma.campaign.update({ where: { id: campaignId }, data: { state: 'COMPLETED', completedAt: at } });
  });
  afterAll(async () => ctx.close());

  it('reports totals, rates, failure reasons and an estimated cost', async () => {
    const res = await admin.agent.get(`/api/campaigns/${campaignId}/report`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      campaignId,
      totals: { pending: 0, queued: 0, sent: 1, delivered: 1, read: 2, failed: 1, skipped: 1, cancelled: 0 },
      failureReasons: [{ code: 131026, reason: 'Message undeliverable', count: 1 }],
      costIsEstimate: true,
    });
    // delivered+read (3) over sent+delivered+read+failed (5); read (2) over delivered+read (3)
    expect(res.body.deliveryRate).toBeCloseTo(0.6, 5);
    expect(res.body.readRate).toBeCloseTo(2 / 3, 5);
    // message 0: billable marketing AE 0.04; messages 1-2: delivered utility 0.01 each
    expect(res.body.estimatedCostUsd).toBeCloseTo(0.06, 6);
  });

  it('exports one row per recipient matching the report, and audits the export', async () => {
    const res = await admin.agent.get(`/api/campaigns/${campaignId}/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename=".+\.csv"/);
    const lines = res.text.trim().split('\n');
    // Feature 009 (FR-037) adds replied, replied_at and clicks.
    expect(lines[0]).toBe('phone,name,status,skip_reason,failure_code,failure_reason,attempts,sent_at,delivered_at,read_at,failed_at,cost_usd,replied,replied_at,clicks');
    const statuses = lines.slice(1).map((l) => l.split(',')[2]);
    expect(statuses.sort()).toEqual(['DELIVERED', 'FAILED', 'READ', 'READ', 'SENT', 'SKIPPED']);
    expect(lines.slice(1).every((l) => /^\+9715\d{8},Report \d,/.test(l))).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'data.exported', targetId: campaignId } })).toBe(1);
  });

  it('keeps exports from agents', async () => {
    const agent = await signIn(ctx, 'AGENT');
    expect((await agent.agent.get(`/api/campaigns/${campaignId}/export`)).status).toBe(403);
    expect((await agent.agent.get(`/api/campaigns/${campaignId}/report`)).status).toBe(200);
  });
});
