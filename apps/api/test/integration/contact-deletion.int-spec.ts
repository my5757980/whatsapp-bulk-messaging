import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T080: deleting a contact's personal data keeps aggregates (FR-015, Principle III).
describe('Contact deletion', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
  });
  afterAll(async () => ctx.close());

  it('removes personal data and consent history but keeps message outcomes and totals', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const phone = uaePhone();
    const target = await seedContact(ctx, phone, { name: 'Delete Me', attributes: { city: 'Dubai' } });
    const other = await seedContact(ctx, uaePhone());
    const tag = await ctx.prisma.tag.create({ data: { name: `vip-${target.id.slice(-6)}` } });
    await ctx.prisma.contactTag.create({ data: { contactId: target.id, tagId: tag.id } });
    await ctx.prisma.consentEvent.create({ data: { contactId: target.id, status: 'OPTED_IN', source: 'MANUAL', note: 'in store' } });

    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [target, other] });
    await ctx.prisma.campaignUploadRow.create({ data: { campaignId: campaign.id, rowNumber: 1, phoneE164: phone, data: { phone, name: 'Delete Me' } } });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id, contactId: target.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id, contactId: other.id }, data: { status: 'READ', readAt: new Date() } });
    await ctx.prisma.campaign.update({ where: { id: campaign.id }, data: { state: 'COMPLETED', completedAt: new Date() } });
    const before = (await admin.agent.get(`/api/campaigns/${campaign.id}`)).body.totals;

    const res = await admin.agent.delete(`/api/contacts/${target.id}`).set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(204);

    expect(await ctx.prisma.contact.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await ctx.prisma.consentEvent.count({ where: { contactId: target.id } })).toBe(0);
    expect(await ctx.prisma.contactTag.count({ where: { contactId: target.id } })).toBe(0);
    expect(await ctx.prisma.campaignUploadRow.count({ where: { phoneE164: phone } })).toBe(0);

    const anonymised = await ctx.prisma.message.findMany({ where: { campaignId: campaign.id, contactId: null } });
    expect(anonymised).toHaveLength(1);
    expect(anonymised[0]).toMatchObject({ phoneE164: null, status: 'DELIVERED', recipientCountry: 'AE' });

    const after = (await admin.agent.get(`/api/campaigns/${campaign.id}`)).body.totals;
    expect(after).toEqual(before);
    expect(after).toMatchObject({ delivered: 1, read: 1 });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'contact.deleted', targetId: target.id } });
    expect(JSON.stringify(audit.metadata)).not.toContain(phone.slice(-7));
  });

  it('is admin-only and returns 404 for unknown contacts', async () => {
    const contact = await seedContact(ctx, uaePhone());
    const manager = await signIn(ctx, 'MANAGER');
    expect((await manager.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', manager.csrf)).status).toBe(403);
    expect((await admin.agent.delete('/api/contacts/0190a000-0000-7000-8000-000000000000').set('x-csrf-token', admin.csrf)).status).toBe(404);
  });
});
