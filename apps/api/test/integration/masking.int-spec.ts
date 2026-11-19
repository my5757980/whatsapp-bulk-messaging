import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T168: agents only ever see the last 4 digits of a phone number (FR-007, constitution III).
describe('Phone masking for agents', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  let manager: SignedInAgent;
  let contactId: string;
  let campaignId: string;
  const phone = uaePhone();
  const name = `Masked ${digits(5)}`;

  const MASKED = /^•••• \d{4}$/;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
    manager = await signIn(ctx, 'MANAGER');
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const contact = await seedContact(ctx, phone, { name });
    contactId = contact.id;
    campaignId = (await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] })).id;
  });
  afterAll(async () => ctx.close());

  it('masks contact lists and details', async () => {
    const list = await agent.agent.get('/api/contacts').query({ q: name });
    expect(list.body.items[0].phone).toMatch(MASKED);
    expect(list.body.items[0].phone.endsWith(phone.slice(-4))).toBe(true);
    expect((await agent.agent.get(`/api/contacts/${contactId}`)).body.phone).toMatch(MASKED);
    expect(JSON.stringify(list.body)).not.toContain(phone.slice(1, -4));
  });

  it('masks campaign recipients', async () => {
    const res = await agent.agent.get(`/api/campaigns/${campaignId}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.items.map((m: { phone: string }) => m.phone)).toEqual([expect.stringMatching(MASKED)]);
  });

  it('shows full numbers to roles with phones.full', async () => {
    expect((await admin.agent.get(`/api/contacts/${contactId}`)).body.phone).toBe(phone);
    expect((await manager.agent.get(`/api/campaigns/${campaignId}/messages`)).body.items[0].phone).toBe(phone);
  });

  it('masks estimate previews for everyone and keeps exports away from agents', async () => {
    const tag = await ctx.prisma.tag.create({ data: { name: `mask-${digits(5)}` } });
    await ctx.prisma.contactTag.create({ data: { contactId, tagId: tag.id } });
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const draft = await manager.agent
      .post('/api/campaigns')
      .set('x-csrf-token', manager.csrf)
      .send({ name: 'Masking preview', numberId: number.id, templateId: template.id, audienceType: 'FILTER', audienceFilter: { all: [{ tag: tag.name }] }, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } } });
    const estimate = await manager.agent.post(`/api/campaigns/${draft.body.id}/estimate`).set('x-csrf-token', manager.csrf);
    expect(estimate.body.previews[0].phoneMasked).toMatch(MASKED);
    expect((await agent.agent.get(`/api/campaigns/${campaignId}/export`)).status).toBe(403);
  });
});
