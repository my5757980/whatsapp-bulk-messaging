import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkTagsProcessor } from '../../src/modules/contacts/bulk-tags.processor.js';
import { digits, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T030 (feature 010 US2, FR-008, FR-009, research R3): bulk add and remove of tags in the background.
describe('Bulk tag actions (010 US2)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  const group = `bulk-${digits(6)}`;
  let groupTagId: string;
  let vipId: string;
  let trialId: string;
  let contactIds: string[] = [];

  const send = (who: SignedInAgent, body: object) => who.agent.post('/api/contacts/bulk-actions').set('X-CSRF-Token', who.csrf).send(body);
  const runAction = async (body: object) => {
    const queued = await send(manager, body);
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    await ctx.app.get(BulkTagsProcessor).run(queued.body.id);
    return (await manager.agent.get(`/api/contacts/bulk-actions/${queued.body.id}`)).body;
  };
  const withTag = (tagId: string) => ctx.prisma.contactTag.count({ where: { tagId, contactId: { in: contactIds } } });

  beforeAll(async () => {
    ctx = await createTestContext();
    [manager, agent] = await Promise.all([signIn(ctx, 'MANAGER'), signIn(ctx, 'AGENT')]);
    groupTagId = (await ctx.prisma.tag.create({ data: { name: group } })).id;
    vipId = (await ctx.prisma.tag.create({ data: { name: `vip-${digits(6)}` } })).id;
    trialId = (await ctx.prisma.tag.create({ data: { name: `trial-${digits(6)}` } })).id;
    // 12,000 contacts, so a filter action runs more than two batches of 5,000.
    const phones = Array.from({ length: 12_000 }, () => uaePhone());
    await ctx.prisma.contact.createMany({ data: phones.map((phoneE164) => ({ phoneE164, countryCode: 'AE', consentStatus: 'OPTED_IN', consentSource: 'MANUAL' })) });
    contactIds = (await ctx.prisma.contact.findMany({ where: { phoneE164: { in: phones } }, select: { id: true } })).map((c) => c.id);
    await ctx.prisma.contactTag.createMany({ data: contactIds.map((contactId) => ({ contactId, tagId: groupTagId })) });
    await ctx.prisma.contactTag.createMany({ data: contactIds.slice(0, 100).map((contactId) => ({ contactId, tagId: trialId })) });
  }, 120_000);
  afterAll(async () => ctx.close());

  it('adds a tag to everyone matching a filter, batch by batch, with counts and an audit entry', async () => {
    const done = await runAction({ kind: 'TAG_ADD', tagIds: [vipId], selection: { filter: { tag: [group] } } });
    expect(done).toMatchObject({ kind: 'TAG_ADD', status: 'DONE', total: 12_000, processed: 12_000, changed: 12_000 });
    expect(await withTag(vipId)).toBe(12_000);
    expect(await ctx.prisma.auditLog.count({ where: { targetId: done.id, action: 'contacts.bulk_tagged' } })).toBe(1);
    // Running it again changes nothing.
    expect(await runAction({ kind: 'TAG_ADD', tagIds: [vipId], selection: { filter: { tag: [group] } } })).toMatchObject({ processed: 12_000, changed: 0 });
  }, 120_000);

  it('removes tags from chosen contacts and from a segment', async () => {
    const chosen = await runAction({ kind: 'TAG_REMOVE', tagIds: [trialId], selection: { contactIds: contactIds.slice(0, 40) } });
    expect(chosen).toMatchObject({ status: 'DONE', total: 40, changed: 40 });
    expect(await withTag(trialId)).toBe(60);

    const segment = await manager.agent
      .post('/api/segments')
      .set('X-CSRF-Token', manager.csrf)
      .send({ name: `Bulk trial ${digits(6)}`, rules: { groups: [{ match: 'all', rules: [{ kind: 'tag', tag: group, has: true }] }] } });
    expect(segment.status).toBe(201);
    const bySegment = await runAction({ kind: 'TAG_REMOVE', tagIds: [trialId], selection: { segmentId: segment.body.id } });
    expect(bySegment).toMatchObject({ status: 'DONE', total: 12_000, changed: 60 });
    expect(await withTag(trialId)).toBe(0);
  }, 120_000);

  it('lists recent actions, refuses unknown tags, and is closed to agents', async () => {
    expect((await manager.agent.get('/api/contacts/bulk-actions')).body.items.length).toBeGreaterThanOrEqual(3);
    expect((await send(manager, { kind: 'TAG_ADD', tagIds: ['0190a000-0000-7000-8000-00000000abcd'], selection: { contactIds: contactIds.slice(0, 1) } })).status).toBe(404);
    expect((await send(agent, { kind: 'TAG_ADD', tagIds: [vipId], selection: { contactIds: contactIds.slice(0, 1) } })).status).toBe(403);
    expect((await agent.agent.get('/api/contacts/bulk-actions')).status).toBe(200);
  });
});
