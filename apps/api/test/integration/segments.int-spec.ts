import { randomUUID } from 'node:crypto';
import type { SegmentRule } from '@wbm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T019 (feature 010 US1, FR-001 – FR-007): saved segments, their counts and broken rules. Every rule is
// combined with a tag only this file's contacts have, so the shared database does not change the counts.
describe('Segments (010 US1)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  const tag = `seg-${digits(6)}`;
  const attr = `segcity${digits(5)}`;
  let campaignId: string;
  const ids: Record<'a' | 'b' | 'c' | 'd', string> = { a: '', b: '', c: '', d: '' };

  const send = (who: SignedInAgent, method: 'post' | 'put' | 'delete', path: string, body?: object) => who.agent[method](`/api${path}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const rules = (...extra: SegmentRule[]) => ({ groups: [{ match: 'all', rules: [{ kind: 'tag', tag, has: true }, ...extra] }] });
  const preview = async (...extra: SegmentRule[]) => {
    const res = await send(manager, 'post', '/segments/preview', { rules: rules(...extra) });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as { count: number; marketable: number; broken: unknown[]; sample: Array<{ id: string; phone: string }> };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    [admin, manager, agent] = await Promise.all([signIn(ctx, 'ADMIN'), signIn(ctx, 'MANAGER'), signIn(ctx, 'AGENT')]);
    await ctx.prisma.attributeDefinition.create({ data: { key: attr, label: 'City', type: 'TEXT' } });
    const theTag = await ctx.prisma.tag.create({ data: { name: tag } });
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const old = new Date(Date.now() - 100 * 86_400_000);
    const a = await seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_IN', attributes: { [attr]: 'Dubai' }, leadSourceKind: 'WEBSITE_BUTTON' });
    const b = await seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_IN', attributes: { [attr]: 'Abu Dhabi' }, leadSourceKind: 'API' });
    const c = await seedContact(ctx, uaePhone(), { consentStatus: 'UNKNOWN', consentSource: null, attributes: { [attr]: 'Dubai' }, leadSourceKind: 'ORGANIC' });
    const d = await seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_IN', attributes: { [attr]: 'Dubai' }, blockedAt: new Date(), createdAt: old });
    Object.assign(ids, { a: a.id, b: b.id, c: c.id, d: d.id });
    await ctx.prisma.contactTag.createMany({ data: [a, b, c, d].map((x) => ({ contactId: x.id, tagId: theTag.id })) });

    // Campaign history: a read it, replied and clicked; b had it delivered; c's failed; d got nothing.
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [a, b, c] });
    campaignId = campaign.id;
    const sent = new Date(Date.now() - 3_600_000);
    const delivered = new Date(Date.now() - 3_000_000);
    await ctx.prisma.message.updateMany({ where: { campaignId, contactId: a.id }, data: { status: 'READ', sentAt: sent, deliveredAt: delivered, readAt: new Date(Date.now() - 2_000_000) } });
    await ctx.prisma.message.updateMany({ where: { campaignId, contactId: b.id }, data: { status: 'DELIVERED', sentAt: sent, deliveredAt: delivered } });
    await ctx.prisma.message.updateMany({ where: { campaignId, contactId: c.id }, data: { status: 'FAILED', sentAt: sent, failedAt: delivered } });
    const chat = await ctx.prisma.conversation.create({ data: { contactId: a.id, numberId: number.id, lastActivityAt: new Date(), lastInboundAt: new Date() } });
    await ctx.prisma.chatMessage.create({ data: { conversationId: chat.id, kind: 'INBOUND', origin: 'CUSTOMER', contentType: 'TEXT', text: 'Yes please', occurredAt: new Date(Date.now() - 1_000_000) } });
    await ctx.prisma.conversation.create({ data: { contactId: d.id, numberId: number.id, lastActivityAt: old, lastInboundAt: new Date(Date.now() - 40 * 86_400_000) } });
    const messageA = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId, contactId: a.id } });
    const target = await ctx.prisma.trackedLinkTarget.create({ data: { campaignId, variableKey: 'BUTTON.0.1', destination: 'https://shop.example.test' } });
    const link = await ctx.prisma.trackedLink.create({ data: { code: randomUUID().replace(/-/g, '').slice(0, 10), targetId: target.id, messageId: messageA.id, contactId: a.id } });
    await ctx.prisma.linkClick.create({ data: { trackedLinkId: link.id, targetId: target.id, campaignId, contactId: a.id, device: 'MOBILE' } });
  });
  afterAll(async () => ctx.close());

  it('counts contacts for every rule kind, with the marketable count', async () => {
    expect(await preview()).toMatchObject({ count: 4, marketable: 2, broken: [] });
    expect((await preview({ kind: 'attr', attr, op: 'eq', value: 'Dubai' })).count).toBe(3);
    expect((await preview({ kind: 'attr', attr, op: 'is_empty' })).count).toBe(0);
    expect(await preview({ kind: 'consent', statuses: ['OPTED_IN'] })).toMatchObject({ count: 3, marketable: 2 });
    expect((await preview({ kind: 'lead_source', sources: ['WEBSITE_BUTTON'] })).count).toBe(1);
    expect((await preview({ kind: 'added', days: 30 })).count).toBe(3);
    expect((await preview({ kind: 'last_inbound', within: true, days: 30 })).count).toBe(1);
    expect((await preview({ kind: 'last_inbound', within: false, days: 30 })).count).toBe(3);
    expect((await preview({ kind: 'blocked', blocked: true })).count).toBe(1);
    expect((await preview({ kind: 'tag', tag: `other-${digits(6)}`, has: false })).broken).toHaveLength(1);
  });

  it('counts campaign behaviour for one campaign and for recent days', async () => {
    const did = (event: 'sent' | 'delivered' | 'read' | 'replied' | 'clicked' | 'failed') => preview({ kind: 'behaviour', event, did: true, campaignId });
    expect((await did('sent')).count).toBe(3);
    expect((await did('delivered')).count).toBe(2);
    expect((await did('read')).count).toBe(1);
    expect((await did('replied')).count).toBe(1);
    expect((await did('clicked')).count).toBe(1);
    expect((await did('failed')).count).toBe(1);
    expect((await preview({ kind: 'behaviour', event: 'read', did: false, campaignId })).count).toBe(3);
    expect((await preview({ kind: 'behaviour', event: 'sent', did: true, days: 30 })).count).toBe(3);
    // Groups: "any of" two lead sources.
    const any = await send(manager, 'post', '/segments/preview', {
      rules: { groups: [{ match: 'all', rules: [{ kind: 'tag', tag, has: true }] }, { match: 'any', rules: [{ kind: 'lead_source', sources: ['WEBSITE_BUTTON'] }, { kind: 'lead_source', sources: ['API'] }] }] },
    });
    expect(any.body.count).toBe(2);
  });

  it('saves, renames, copies, counts and deletes segments, with audit entries', async () => {
    const name = `Dubai customers ${digits(6)}`;
    const created = await send(manager, 'post', '/segments', { name, rules: rules({ kind: 'attr', attr, op: 'eq', value: 'Dubai' }) });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ name, broken: [], usedBy: [] });
    expect((await send(manager, 'post', '/segments', { name, rules: rules() })).status).toBe(409);
    const id = created.body.id as string;
    expect((await manager.agent.get(`/api/segments/${id}/count`)).body).toEqual({ count: 3, marketable: 1, broken: [] });
    expect((await send(manager, 'put', `/segments/${id}`, { name: `${name} (renamed)`, rules: rules() })).body.name).toBe(`${name} (renamed)`);
    const copy = await send(manager, 'post', `/segments/${id}/copy`, { name: `${name} copy` });
    expect(copy.status).toBe(201);
    expect((await manager.agent.get('/api/segments')).body.items.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining([id, copy.body.id]));
    expect(await ctx.prisma.auditLog.count({ where: { targetId: id, action: { in: ['segment.created', 'segment.updated'] } } })).toBe(2);
    expect((await send(manager, 'delete', `/segments/${copy.body.id}`)).status).toBe(204);
    expect(await ctx.prisma.auditLog.count({ where: { targetId: copy.body.id, action: 'segment.deleted' } })).toBe(1);
  });

  it('refuses rules naming missing things on save, and shows rules broken later', async () => {
    const missing = `gone-${digits(6)}`;
    const refused = await send(manager, 'post', '/segments', { name: `Broken ${digits(6)}`, rules: rules({ kind: 'tag', tag: missing, has: true }) });
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('SEGMENT_BROKEN');
    const temp = await ctx.prisma.tag.create({ data: { name: `temp-${digits(6)}` } });
    const saved = await send(manager, 'post', '/segments', { name: `Temp ${digits(6)}`, rules: rules({ kind: 'tag', tag: temp.name, has: true }) });
    await ctx.prisma.tag.delete({ where: { id: temp.id } });
    expect((await manager.agent.get(`/api/segments/${saved.body.id}`)).body.broken).toEqual([{ group: 0, rule: 1, issue: 'TAG_MISSING' }]);
  });

  it('lets agents filter by segments and see counts, but not change them; the list filters by segment', async () => {
    const saved = await send(manager, 'post', '/segments', { name: `Agents ${digits(6)}`, rules: rules({ kind: 'blocked', blocked: false }) });
    expect((await agent.agent.get('/api/segments')).status).toBe(200);
    expect((await agent.agent.get(`/api/segments/${saved.body.id}/count`)).body.count).toBe(3);
    expect((await send(agent, 'post', '/segments', { name: 'Nope', rules: rules() })).status).toBe(403);
    expect((await send(agent, 'post', '/segments/preview', { rules: rules() })).status).toBe(403);
    const list = await agent.agent.get(`/api/contacts?segmentId=${saved.body.id}&pageSize=50`);
    expect(list.status).toBe(200);
    expect(list.body.items.map((c: { id: string }) => c.id).sort()).toEqual([ids.a, ids.b, ids.c].sort());
    expect(list.body.page.total).toBe(3);
    const byLead = await agent.agent.get(`/api/contacts?tag=${tag}&leadSource=WEBSITE_BUTTON`);
    expect(byLead.body.items.map((c: { id: string; leadSource: string }) => [c.id, c.leadSource])).toEqual([[ids.a, 'WEBSITE_BUTTON']]);
  });
});
