import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T155: retargeting by status (FR-031) and rate card maintenance (FR-029).
describe('Retargeting and the rate card', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let sourceId: string;
  const byStatus: Record<string, string[]> = {};

  const post = (path: string, body?: unknown, who: SignedInAgent = admin) => who.agent.post(path).set('x-csrf-token', who.csrf).send(body as object);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' });
    const statuses = ['READ', 'READ', 'DELIVERED', 'SENT', 'FAILED', 'FAILED'] as const;
    const contacts = [];
    for (let i = 0; i < statuses.length; i++) contacts.push(await seedContact(ctx, uaePhone(), { name: `Retarget ${i}` }));
    const source = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts });
    sourceId = source.id;
    for (let i = 0; i < statuses.length; i++) {
      await ctx.prisma.message.updateMany({ where: { campaignId: sourceId, contactId: contacts[i]!.id }, data: { status: statuses[i] } });
      (byStatus[statuses[i]!] ??= []).push(contacts[i]!.id);
    }
    // One failed recipient has since opted out: retargeting must exclude them.
    await ctx.prisma.contact.update({ where: { id: contacts[5]!.id }, data: { consentStatus: 'OPTED_OUT' } });
    await ctx.prisma.campaign.update({ where: { id: sourceId }, data: { state: 'COMPLETED', completedAt: new Date() } });
  });
  afterAll(async () => ctx.close());

  it.each([
    ['FAILED', 1, 1],
    ['NOT_READ', 2, 0],
    ['READ', 2, 0],
    ['DELIVERED', 3, 0],
  ] as const)('creates a draft from %s recipients (eligible %i, opted-out excluded %i)', async (status, eligible, optedOut) => {
    const res = await post(`/api/campaigns/${sourceId}/retarget`, { status });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ state: 'DRAFT', audienceType: 'RETARGET', sourceCampaignId: sourceId, retargetStatus: status });
    expect(res.body.name).toMatch(/retarget/i);
    const estimate = await post(`/api/campaigns/${res.body.id}/estimate`);
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({ eligible, excluded: { optedOut } });
  });

  it('launches a retarget draft only to the selected recipients', async () => {
    const draft = await post(`/api/campaigns/${sourceId}/retarget`, { status: 'READ' });
    expect((await post(`/api/campaigns/${draft.body.id}/launch`, {})).status).toBe(200);
    const messages = await ctx.prisma.message.findMany({ where: { campaignId: draft.body.id } });
    expect(messages.map((m) => m.contactId).sort()).toEqual([...byStatus.READ!].sort());
  });

  it('validates the retarget status and permissions', async () => {
    expect((await post(`/api/campaigns/${sourceId}/retarget`, { status: 'BOUNCED' })).status).toBe(422);
    const agent = await signIn(ctx, 'AGENT');
    expect((await post(`/api/campaigns/${sourceId}/retarget`, { status: 'FAILED' }, agent)).status).toBe(403);
  });

  it('replaces the rate card with validated USD entries', async () => {
    const entries = [
      { category: 'MARKETING', countryCode: 'AE', priceUsd: 0.0384, effectiveFrom: '2026-01-01' },
      { category: 'MARKETING', countryCode: '*', priceUsd: 0.05, effectiveFrom: '2026-01-01' },
      { category: 'UTILITY', countryCode: 'ae', priceUsd: 0.0157, effectiveFrom: '2026-07-01' },
    ];
    const saved = await admin.agent.put('/api/rate-card').set('x-csrf-token', admin.csrf).send(entries);
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual(expect.arrayContaining([{ category: 'UTILITY', countryCode: 'AE', priceUsd: 0.0157, effectiveFrom: '2026-07-01' }]));
    expect(saved.body).toHaveLength(3);
    expect((await ctx.prisma.rateCardEntry.findFirstOrThrow({ where: { countryCode: '*' } })).priceUsdMicros).toBe(50_000n);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'rate_card.updated' } })).toBeGreaterThanOrEqual(1);

    const listed = await admin.agent.get('/api/rate-card');
    expect(listed.body).toHaveLength(3);

    const put = (body: unknown) => admin.agent.put('/api/rate-card').set('x-csrf-token', admin.csrf).send(body as object);
    expect((await put([{ ...entries[0], priceUsd: -1 }])).status).toBe(422);
    expect((await put([{ ...entries[0], countryCode: 'UAE' }])).status).toBe(422);
    expect((await put([{ ...entries[0], effectiveFrom: '01/01/2026' }])).status).toBe(422);
    expect((await put([entries[0], entries[0]])).status).toBe(422);

    const manager = await signIn(ctx, 'MANAGER');
    expect((await manager.agent.put('/api/rate-card').set('x-csrf-token', manager.csrf).send(entries)).status).toBe(403);
    expect((await manager.agent.get('/api/rate-card')).status).toBe(200);
  });
});
