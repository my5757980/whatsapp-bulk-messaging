import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedContact, seedNumber, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T020 (feature 010 US1, FR-004, FR-006): a segment as a campaign audience, read at launch.
describe('Campaigns with a segment audience (010 US1)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let numberId: string;
  let wabaId: string;
  const tag = `segaud-${digits(6)}`;
  let tagId: string;

  const send = (method: 'post' | 'patch' | 'delete', path: string, body?: object) => manager.agent[method](`/api${path}`).set('X-CSRF-Token', manager.csrf).send(body ?? {});
  const segment = async (name: string, tagName: string) => {
    const res = await send('post', '/segments', { name, rules: { groups: [{ match: 'all', rules: [{ kind: 'tag', tag: tagName, has: true }] }] } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const tagContact = async (consentStatus: 'OPTED_IN' | 'OPTED_OUT') => {
    const c = await seedContact(ctx, uaePhone(), { consentStatus, name: 'Segment person' });
    await ctx.prisma.contactTag.create({ data: { contactId: c.id, tagId } });
    return c;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    const number = await seedNumber(ctx);
    numberId = number.id;
    wabaId = number.wabaId;
    tagId = (await ctx.prisma.tag.create({ data: { name: tag } })).id;
  });
  afterAll(async () => ctx.close());

  it('estimates from the segment and launches to its members at launch time', async () => {
    const x = await tagContact('OPTED_IN');
    const y = await tagContact('OPTED_OUT');
    const segmentId = await segment(`Audience ${digits(6)}`, tag);
    const template = await seedTemplate(ctx, wabaId);
    const base = { name: `Segment campaign ${digits(4)}`, numberId, templateId: template.id, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } } };

    expect((await send('post', '/campaigns', { ...base, audienceType: 'SEGMENT' })).status).toBe(422);
    const draft = await send('post', '/campaigns', { ...base, audienceType: 'SEGMENT', segmentId });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ audienceType: 'SEGMENT', segmentId });

    const estimate = await send('post', `/campaigns/${draft.body.id}/estimate`);
    expect(estimate.status, JSON.stringify(estimate.body)).toBe(200);
    expect(estimate.body).toMatchObject({ eligible: 1, excluded: { optedOut: 1 } });

    // A member who joins after the draft was made is in the launch.
    const w = await tagContact('OPTED_IN');
    expect((await send('delete', `/segments/${segmentId}`)).status).toBe(409);
    const launched = await send('post', `/campaigns/${draft.body.id}/launch`, {});
    expect(launched.status, JSON.stringify(launched.body)).toBe(200);
    const rows = await ctx.prisma.message.findMany({ where: { campaignId: draft.body.id }, select: { contactId: true, status: true, skipReason: true } });
    expect(rows.filter((r) => r.status === 'PENDING').map((r) => r.contactId).sort()).toEqual([x.id, w.id].sort());
    expect(rows.find((r) => r.contactId === y.id)).toMatchObject({ status: 'SKIPPED', skipReason: 'OPTED_OUT' });
  });

  it('refuses the estimate and the launch while the segment is broken', async () => {
    const temp = await ctx.prisma.tag.create({ data: { name: `segbrk-${digits(6)}` } });
    const segmentId = await segment(`Broken audience ${digits(6)}`, temp.name);
    const template = await seedTemplate(ctx, wabaId);
    const draft = await send('post', '/campaigns', {
      name: `Broken ${digits(4)}`,
      numberId,
      templateId: template.id,
      audienceType: 'SEGMENT',
      segmentId,
      variableMapping: { 'BODY.1': { source: 'static', value: 'friend' } },
    });
    await ctx.prisma.tag.delete({ where: { id: temp.id } });
    const estimate = await send('post', `/campaigns/${draft.body.id}/estimate`);
    expect(estimate.status).toBe(422);
    expect(estimate.body.code).toBe('SEGMENT_BROKEN');
    expect((await send('post', `/campaigns/${draft.body.id}/launch`, {})).body.code).toBe('SEGMENT_BROKEN');
    const segmentRow = await manager.agent.get(`/api/segments/${segmentId}`);
    expect(segmentRow.body.usedBy).toEqual([expect.objectContaining({ id: draft.body.id, state: 'DRAFT' })]);
  });

  it('clears the segment when the audience changes to another type', async () => {
    const segmentId = await segment(`Switch ${digits(6)}`, tag);
    const template = await seedTemplate(ctx, wabaId);
    const draft = await send('post', '/campaigns', { name: `Switch ${digits(4)}`, numberId, templateId: template.id, audienceType: 'SEGMENT', segmentId, variableMapping: { 'BODY.1': { source: 'static', value: 'x' } } });
    const switched = await send('patch', `/campaigns/${draft.body.id}`, { audienceType: 'ALL_OPTED_IN' });
    expect(switched.status, JSON.stringify(switched.body)).toBe(200);
    expect(switched.body).toMatchObject({ audienceType: 'ALL_OPTED_IN', segmentId: null });
    expect((await send('delete', `/segments/${segmentId}`)).status).toBe(204);
  });
});
