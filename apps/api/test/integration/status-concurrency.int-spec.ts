import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StatusHandler } from '../../src/modules/webhooks/handlers/status.handler.js';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, type TestContext } from '../support/test-context.js';

// Webhooks are processed in parallel (the 10k-campaign perf run showed one-at-a-time processing
// falls far behind). Concurrent statuses for the same message must never lose an update.
describe('Status webhooks processed in parallel', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  it('ends every message at READ when sent, delivered and read arrive at the same time', async () => {
    const userId = (await ctx.prisma.user.create({ data: { email: `parallel-${Date.now()}@test.local`, name: 'Owner', role: 'ADMIN', status: 'ACTIVE', passwordHash: 'unused' } })).id;
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const contacts = await Promise.all(Array.from({ length: 12 }, () => seedContact(ctx, uaePhone())));
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: userId, contacts });
    const messages = await ctx.prisma.message.findMany({ where: { campaignId: campaign.id }, orderBy: { id: 'asc' } });
    const sentAt = new Date(Date.now() - 60_000);
    const wamid = (i: number) => `wamid.parallel.${campaign.id}.${i}`;
    for (const [i, m] of messages.entries()) {
      await ctx.prisma.message.update({ where: { id: m.id }, data: { status: 'SENT', sentAt, waMessageId: wamid(i) } });
    }

    const handler = ctx.app.get(StatusHandler);
    const events = messages.flatMap((_, i) =>
      (['sent', 'delivered', 'read'] as const).map((status, k) => ({ wamid: wamid(i), status, timestamp: new Date(sentAt.getTime() + (k + 1) * 1000), recipientId: undefined })),
    );
    await Promise.all(events.map((event) => handler.apply(event)));

    const after = await ctx.prisma.message.findMany({ where: { campaignId: campaign.id }, select: { status: true, deliveredAt: true, readAt: true } });
    expect(after.filter((m) => m.status !== 'READ')).toEqual([]);
    expect(after.every((m) => m.deliveredAt !== null && m.readAt !== null)).toBe(true);
    expect(await ctx.prisma.messageEvent.count({ where: { message: { campaignId: campaign.id } } })).toBe(messages.length * 3);
  });
});
