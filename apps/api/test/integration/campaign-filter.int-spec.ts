import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedContact, seedNumber, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T126: FILTER and ALL_OPTED_IN audiences in estimate and launch (FR-014, research R11).
describe('Filter audiences', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let numberId: string;
  let wabaId: string;
  const tagName = `flt-${digits(4)}`;

  const send = (method: 'post' | 'patch', path: string, body?: unknown) => admin.agent[method](path).set('x-csrf-token', admin.csrf).send(body as object);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    numberId = number.id;
    wabaId = number.wabaId;
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    const contacts = await Promise.all(
      (['OPTED_IN', 'UNKNOWN', 'OPTED_OUT'] as const).map((consentStatus, i) => seedContact(ctx, uaePhone(), { consentStatus, name: `Filter ${i}` })),
    );
    await ctx.prisma.contactTag.createMany({ data: contacts.map((c) => ({ contactId: c.id, tagId: tag.id })) });
  });
  afterAll(async () => ctx.close());

  it('estimates and launches a tag filter, recording opted-out contacts as skipped', async () => {
    const template = await seedTemplate(ctx, wabaId);
    const draft = await send('post', '/api/campaigns', {
      name: 'Filter campaign',
      numberId,
      templateId: template.id,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag: tagName }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' } },
    });
    expect(draft.status).toBe(201);
    expect(draft.body.audienceFilter).toEqual({ all: [{ tag: tagName }] });

    const estimate = await send('post', `/api/campaigns/${draft.body.id}/estimate`);
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({ eligible: 2, excluded: { optedOut: 1, noOptIn: 0, invalidNumber: 0, duplicate: 0, missingVariable: 0 } });
    expect(estimate.body.previews[0].text).toMatch(/^Hi Filter \d, your order is ready\.$/);

    const launched = await send('post', `/api/campaigns/${draft.body.id}/launch`, {});
    expect(launched.status).toBe(200);
    const rows = await ctx.prisma.message.groupBy({ by: ['status', 'skipReason'], where: { campaignId: draft.body.id }, _count: { _all: true } });
    expect(rows.map((r) => [r.status, r.skipReason, r._count._all]).sort()).toEqual([
      ['PENDING', null, 2],
      ['SKIPPED', 'OPTED_OUT', 1],
    ]);
  });

  it('needs an explicit opt-in for marketing templates', async () => {
    const marketing = await seedTemplate(ctx, wabaId, { category: 'MARKETING' });
    const draft = await send('post', '/api/campaigns', {
      name: 'Marketing filter',
      numberId,
      templateId: marketing.id,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag: tagName }] },
      variableMapping: { 'BODY.1': { source: 'static', value: 'friend' } },
    });
    const estimate = await send('post', `/api/campaigns/${draft.body.id}/estimate`);
    expect(estimate.body).toMatchObject({ eligible: 1, excluded: { optedOut: 1, noOptIn: 1 } });
  });

  it('sends ALL_OPTED_IN audiences only to opted-in contacts', async () => {
    const template = await seedTemplate(ctx, wabaId);
    const draft = await send('post', '/api/campaigns', {
      name: 'Everyone opted in',
      numberId,
      templateId: template.id,
      audienceType: 'ALL_OPTED_IN',
      variableMapping: { 'BODY.1': { source: 'static', value: 'friend' } },
    });
    const optedIn = await ctx.prisma.contact.count({ where: { consentStatus: 'OPTED_IN' } });
    const estimate = await send('post', `/api/campaigns/${draft.body.id}/estimate`);
    expect(estimate.body).toMatchObject({ eligible: optedIn, excluded: { optedOut: 0, noOptIn: 0 } });
  });

  it('validates filter rules when the draft is saved', async () => {
    const template = await seedTemplate(ctx, wabaId);
    const draft = await send('post', '/api/campaigns', { name: 'Bad filter', numberId, templateId: template.id, audienceType: 'FILTER' });
    const bad = await send('patch', `/api/campaigns/${draft.body.id}`, { audienceFilter: { all: [{ attr: 'missing_attribute', op: 'eq', value: 'x' }] } });
    expect(bad.status).toBe(422);
    const shape = await send('patch', `/api/campaigns/${draft.body.id}`, { audienceFilter: { all: [{ color: 'red' }] } });
    expect(shape.status).toBe(422);
  });
});
