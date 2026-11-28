import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BulkTagsProcessor } from '../../src/modules/contacts/bulk-tags.processor.js';
import { DripSegmentEnrolProcessor } from '../../src/modules/growth/drips/drip-segment-enrol.processor.js';
import { digits, seedContact, seedNumber, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T021 (feature 010 US1, FR-005, research R2): a segment's current members join a drip as a bulk action.
describe('Enrolling a segment in a drip (010 US1)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let dripId: string;
  let segmentId: string;
  const tag = `segdrip-${digits(6)}`;

  const send = (method: 'post', path: string, body?: object) => manager.agent[method](`/api${path}`).set('X-CSRF-Token', manager.csrf).send(body ?? {});

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    const number = await seedNumber(ctx);
    dripId = (await ctx.prisma.drip.create({ data: { name: `Segment drip ${digits(6)}`, numberId: number.id, status: 'ACTIVE' } })).id;
    const tagRow = await ctx.prisma.tag.create({ data: { name: tag } });
    const people = await Promise.all([
      seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_IN' }),
      seedContact(ctx, uaePhone(), { consentStatus: 'UNKNOWN', consentSource: null }),
      seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_OUT' }),
    ]);
    await ctx.prisma.contactTag.createMany({ data: people.map((p) => ({ contactId: p.id, tagId: tagRow.id })) });
    const segment = await send('post', '/segments', { name: `Drip members ${digits(6)}`, rules: { groups: [{ match: 'all', rules: [{ kind: 'tag', tag, has: true }] }] } });
    segmentId = segment.body.id;
  });
  afterAll(async () => ctx.close());

  it('queues a DRIP_ENROL bulk action and enrols the members with the 005 counts', async () => {
    const queued = await send('post', `/drips/${dripId}/enrolments`, { segmentId });
    expect(queued.status, JSON.stringify(queued.body)).toBe(202);
    expect(queued.body).toMatchObject({ kind: 'DRIP_ENROL', status: 'QUEUED' });
    await ctx.app.get(DripSegmentEnrolProcessor).run(queued.body.id);
    const done = await manager.agent.get(`/api/contacts/bulk-actions/${queued.body.id}`);
    expect(done.body).toMatchObject({ status: 'DONE', total: 3, processed: 3, changed: 2, result: { enrolled: 2, skippedOptedOut: 1, skippedAlreadyIn: 0, skippedNotFound: 0 } });
    expect(await ctx.prisma.dripEnrolment.count({ where: { dripId, status: 'ACTIVE' } })).toBe(2);

    // A second run skips those already in.
    const again = await send('post', `/drips/${dripId}/enrolments`, { segmentId });
    await ctx.app.get(DripSegmentEnrolProcessor).run(again.body.id);
    expect((await manager.agent.get(`/api/contacts/bulk-actions/${again.body.id}`)).body.result).toMatchObject({ enrolled: 0, skippedAlreadyIn: 2, skippedOptedOut: 1 });
    expect(await ctx.prisma.auditLog.count({ where: { targetId: dripId, action: 'drip.contacts_enrolled' } })).toBe(2);
  });

  it('refuses a paused drip and an unknown segment, and ignores tag jobs for enrolments', async () => {
    const paused = await ctx.prisma.drip.create({ data: { name: `Paused ${digits(6)}`, numberId: (await seedNumber(ctx)).id, status: 'PAUSED' } });
    expect((await send('post', `/drips/${paused.id}/enrolments`, { segmentId })).status).toBe(409);
    expect((await send('post', `/drips/${dripId}/enrolments`, { segmentId: '0190a000-0000-7000-8000-00000000abcd' })).status).toBe(404);
    const queued = await send('post', `/drips/${dripId}/enrolments`, { segmentId });
    await ctx.app.get(BulkTagsProcessor).run(queued.body.id);
    expect((await manager.agent.get(`/api/contacts/bulk-actions/${queued.body.id}`)).body.status).toBe('QUEUED');
  });
});
