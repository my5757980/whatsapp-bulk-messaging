import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutoTagService } from '../../src/modules/contacts/auto-tags.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { digits, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T031 (feature 010 US2, FR-010, research R4): automatic tag rules.
describe('Automatic tag rules (010 US2)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  const tagIds: Record<string, string> = {};

  const send = (who: SignedInAgent, method: 'post' | 'put' | 'delete', path: string, body?: object) => who.agent[method](`/api${path}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const rule = async (event: string, tag: string, leadSource?: string) => {
    const res = await send(admin, 'post', '/auto-tag-rules', { event, tagId: tagIds[tag], ...(leadSource ? { leadSource } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const tagsOf = async (contactId: string) =>
    (await ctx.prisma.contactTag.findMany({ where: { contactId }, select: { tag: { select: { name: true } } } })).map((t) => t.tag.name);
  const inbound = async (from: string, text: string) => ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, from.slice(1), text)));

  beforeAll(async () => {
    ctx = await createTestContext();
    [admin, manager] = await Promise.all([signIn(ctx, 'ADMIN'), signIn(ctx, 'MANAGER')]);
    number = await seedNumber(ctx);
    for (const name of ['organic', 'manual', 'replied', 'clicked', 'optin', 'optout']) tagIds[name] = (await ctx.prisma.tag.create({ data: { name: `auto-${name}-${digits(6)}` } })).id;
  });
  afterAll(async () => ctx.close());

  it('keeps rules for admins; managers can only read them', async () => {
    const id = await rule('CONTACT_CREATED', 'organic', 'ORGANIC');
    expect((await send(admin, 'post', '/auto-tag-rules', { event: 'CONTACT_CREATED', leadSource: 'ORGANIC', tagId: tagIds.organic })).status).toBe(409);
    expect((await send(admin, 'post', '/auto-tag-rules', { event: 'LINK_CLICK', leadSource: 'API', tagId: tagIds.clicked })).status).toBe(422);
    expect((await manager.agent.get('/api/auto-tag-rules')).body.items.some((r: { id: string }) => r.id === id)).toBe(true);
    expect((await send(manager, 'post', '/auto-tag-rules', { event: 'OPTED_IN', tagId: tagIds.optin })).status).toBe(403);
    expect(await ctx.prisma.auditLog.count({ where: { targetId: id, action: 'auto_tag_rule.changed' } })).toBe(1);
  });

  it('tags new contacts by their lead source, only after the rule exists', async () => {
    const before = await seedContact(ctx, uaePhone(), { leadSourceKind: 'CUSTOM' });
    await rule('CONTACT_CREATED', 'manual', 'CUSTOM');
    ctx.app.get(AutoTagService)['cache'] = null;
    const created = await send(manager, 'post', '/contacts', { phone: uaePhone(), name: 'By hand' });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ leadSource: 'CUSTOM', leadSourceLabel: 'Added by hand' });
    expect(await tagsOf(created.body.id)).toContain(`${(await ctx.prisma.tag.findUniqueOrThrow({ where: { id: tagIds.manual } })).name}`);
    expect(await tagsOf(before.id)).toEqual([]);

    // A customer who writes first is ORGANIC and gets the organic tag.
    const phone = uaePhone();
    await inbound(phone, 'Hello there');
    const organic = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } });
    expect(organic.leadSourceKind).toBe('ORGANIC');
    expect((await tagsOf(organic.id)).some((t) => t.startsWith('auto-organic-'))).toBe(true);
  });

  it('tags campaign replies, link clicks, opt-ins and opt-outs, and a removed tag comes back with the next event', async () => {
    await rule('CAMPAIGN_REPLY', 'replied');
    await rule('LINK_CLICK', 'clicked');
    await rule('OPTED_IN', 'optin');
    await rule('OPTED_OUT', 'optout');
    ctx.app.get(AutoTagService)['cache'] = null;
    const phone = uaePhone();
    const contact = await seedContact(ctx, phone, { consentStatus: 'UNKNOWN', consentSource: null });
    const template = await seedTemplate(ctx, number.wabaId);
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id }, data: { status: 'DELIVERED', sentAt: new Date(Date.now() - 600_000), deliveredAt: new Date(Date.now() - 500_000) } });

    await inbound(phone, 'Interested!');
    expect((await tagsOf(contact.id)).some((t) => t.startsWith('auto-replied-'))).toBe(true);

    const message = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: campaign.id } });
    const target = await ctx.prisma.trackedLinkTarget.create({ data: { campaignId: campaign.id, variableKey: 'BUTTON.0.1', destination: 'https://shop.example.test/lamp' } });
    const code = randomUUID().replace(/-/g, '').slice(0, 10);
    await ctx.prisma.trackedLink.create({ data: { code, targetId: target.id, messageId: message.id, contactId: contact.id } });
    const clicked = await request(ctx.server()).get(`/l/${code}`).set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
    expect(clicked.status).toBe(302);
    expect((await tagsOf(contact.id)).some((t) => t.startsWith('auto-clicked-'))).toBe(true);

    await inbound(phone, 'START');
    expect((await tagsOf(contact.id)).some((t) => t.startsWith('auto-optin-'))).toBe(true);
    await inbound(phone, 'STOP');
    expect((await tagsOf(contact.id)).some((t) => t.startsWith('auto-optout-'))).toBe(true);

    // Removed by hand, the opt-in tag returns only when the contact opts in again.
    await ctx.prisma.contactTag.deleteMany({ where: { contactId: contact.id, tagId: tagIds.optin } });
    expect((await tagsOf(contact.id)).some((t) => t.startsWith('auto-optin-'))).toBe(false);
    await inbound(phone, 'START');
    expect((await tagsOf(contact.id)).some((t) => t.startsWith('auto-optin-'))).toBe(true);
  });

  it('switches rules off and deletes them', async () => {
    const id = await rule('CONTACT_CREATED', 'organic', 'API');
    expect((await send(admin, 'put', `/auto-tag-rules/${id}`, { enabled: false })).body.enabled).toBe(false);
    expect((await send(admin, 'delete', `/auto-tag-rules/${id}`)).status).toBe(204);
    expect(await ctx.prisma.auditLog.count({ where: { targetId: id, action: 'auto_tag_rule.changed' } })).toBe(3);
  });
});
