import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedContact, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T114: contacts CRUD, search, filters, bulk actions and audience preview (FR-009, FR-012, FR-014).
describe('Contacts API', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  const suffix = digits(4);
  const city = `city_${suffix}`;
  const spend = `spend_${suffix}`;
  const vip = `vip-${suffix}`;
  const phone = `+97150444${suffix}`.slice(0, 13);
  let contactId: string;

  const post = (path: string, body: unknown, who: SignedInAgent = admin) => who.agent.post(path).set('x-csrf-token', who.csrf).send(body as object);
  const patch = (path: string, body: unknown) => admin.agent.patch(path).set('x-csrf-token', admin.csrf).send(body as object);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    await setDefaultCountry(ctx, 'AE');
    await ctx.prisma.attributeDefinition.createMany({
      data: [
        { key: city, label: 'City', type: 'TEXT' },
        { key: spend, label: 'Spend', type: 'NUMBER' },
      ],
    });
  });
  afterAll(async () => ctx.close());

  it('creates a contact with tags, typed attributes and documented consent', async () => {
    const national = `0${phone.slice(4)}`; // default country AE applies
    const res = await post('/api/contacts', {
      phone: national,
      name: 'Rania',
      tags: [` ${vip.toUpperCase()} `, 'newsletter'],
      attributes: { [city]: 'Dubai', [spend]: '250' },
      consentStatus: 'OPTED_IN',
      consentSourceNote: 'Signed paper form at the store',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      phone,
      countryCode: 'AE',
      name: 'Rania',
      tags: ['newsletter', vip],
      attributes: { [city]: 'Dubai', [spend]: 250 },
      consentStatus: 'OPTED_IN',
      consentSource: 'MANUAL',
    });
    contactId = res.body.id;

    expect((await post('/api/contacts', { phone })).status).toBe(409);
    expect((await post('/api/contacts', { phone: '12345' })).status).toBe(422);
    expect((await post('/api/contacts', { phone: uaePhone(), attributes: { nope: 1 } })).status).toBe(422);
    expect((await post('/api/contacts', { phone: uaePhone(), attributes: { [spend]: 'a lot' } })).status).toBe(422);
    expect((await post('/api/contacts', { phone: uaePhone(), consentStatus: 'OPTED_IN' })).status).toBe(422);
  });

  it('returns the consent history and updates fields, tags, attributes and consent', async () => {
    const detail = await admin.agent.get(`/api/contacts/${contactId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.consentHistory).toEqual([
      { status: 'OPTED_IN', source: 'MANUAL', note: 'Signed paper form at the store', createdAt: expect.any(String) },
    ]);

    const res = await patch(`/api/contacts/${contactId}`, {
      name: 'Rania K',
      tags: [vip],
      attributes: { [city]: null, [spend]: 300 },
      consentStatus: 'OPTED_OUT',
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Rania K', tags: [vip], attributes: { [spend]: 300 }, consentStatus: 'OPTED_OUT' });
    expect(res.body.attributes).not.toHaveProperty(city);

    const history = (await admin.agent.get(`/api/contacts/${contactId}`)).body.consentHistory;
    expect(history.map((h: { status: string }) => h.status)).toEqual(['OPTED_OUT', 'OPTED_IN']);
    expect((await patch(`/api/contacts/${contactId}`, { consentStatus: 'OPTED_IN' })).status).toBe(422); // needs a note
    expect((await admin.agent.get('/api/contacts/0190a000-0000-7000-8000-000000000000')).status).toBe(404);
  });

  it('searches by name or phone and filters by tag and consent', async () => {
    const tag = await ctx.prisma.tag.create({ data: { name: `filter-${suffix}` } });
    const a = await seedContact(ctx, uaePhone(), { name: `Zubair ${suffix}`, consentStatus: 'OPTED_IN' });
    const b = await seedContact(ctx, uaePhone(), { name: `Yasmin ${suffix}`, consentStatus: 'OPTED_OUT' });
    await ctx.prisma.contactTag.createMany({ data: [a, b].map((c) => ({ contactId: c.id, tagId: tag.id })) });

    const byName = await admin.agent.get('/api/contacts').query({ q: `zubair ${suffix}` });
    expect(byName.body.items.map((c: { id: string }) => c.id)).toEqual([a.id]);
    const byPhone = await admin.agent.get('/api/contacts').query({ q: b.phoneE164.slice(-7) });
    expect(byPhone.body.items.map((c: { id: string }) => c.id)).toContain(b.id);

    const tagged = await admin.agent.get('/api/contacts').query({ tag: tag.name });
    expect(tagged.body.page.total).toBe(2);
    const taggedOut = await admin.agent.get('/api/contacts').query({ tag: tag.name, consent: 'OPTED_OUT' });
    expect(taggedOut.body.items.map((c: { id: string }) => c.id)).toEqual([b.id]);
    const paged = await admin.agent.get('/api/contacts').query({ pageSize: 1, page: 1 });
    expect(paged.body.page).toMatchObject({ page: 1, pageSize: 1 });
    expect(paged.body.items).toHaveLength(1);
  });

  it('applies bulk tag and attribute actions', async () => {
    const c1 = await seedContact(ctx, uaePhone());
    const c2 = await seedContact(ctx, uaePhone());
    const ids = [c1.id, c2.id];
    const bulkTag = `bulk-${suffix}`;

    expect((await post('/api/contacts/bulk', { contactIds: ids, action: 'ADD_TAG', tag: bulkTag })).body).toEqual({ updated: 2 });
    expect((await post('/api/contacts/bulk', { contactIds: ids, action: 'ADD_TAG', tag: bulkTag })).body).toEqual({ updated: 0 });
    expect((await post('/api/contacts/bulk', { contactIds: ids, action: 'REMOVE_TAG', tag: bulkTag })).body).toEqual({ updated: 2 });
    expect((await post('/api/contacts/bulk', { contactIds: ids, action: 'SET_ATTRIBUTE', attributeKey: spend, attributeValue: '99' })).body).toEqual({ updated: 2 });
    expect((await ctx.prisma.contact.findUniqueOrThrow({ where: { id: c1.id } })).attributes).toMatchObject({ [spend]: 99 });

    expect((await post('/api/contacts/bulk', { contactIds: ids, action: 'SET_ATTRIBUTE', attributeKey: spend, attributeValue: 'abc' })).status).toBe(422);
    expect((await post('/api/contacts/bulk', { contactIds: ids, action: 'SET_ATTRIBUTE', attributeKey: 'nope', attributeValue: 1 })).status).toBe(422);
    expect((await post('/api/contacts/bulk', { contactIds: ids, action: 'ADD_TAG' })).status).toBe(422);
  });

  it('previews audience counts and always excludes opted-out contacts', async () => {
    const tag = await ctx.prisma.tag.create({ data: { name: `aud-${suffix}` } });
    const contacts = await Promise.all(
      (['OPTED_IN', 'UNKNOWN', 'OPTED_OUT'] as const).map((consentStatus) => seedContact(ctx, uaePhone(), { consentStatus, attributes: { [spend]: 500 } })),
    );
    await ctx.prisma.contactTag.createMany({ data: contacts.map((c) => ({ contactId: c.id, tagId: tag.id })) });

    const utility = await post('/api/contacts/audience-preview', { filter: { all: [{ tag: tag.name }] }, templateCategory: 'UTILITY' });
    expect(utility.status).toBe(200);
    expect(utility.body).toEqual({ eligible: 2, excluded: { optedOut: 1, noOptIn: 0, invalidNumber: 0, duplicate: 0, missingVariable: 0 } });

    const marketing = await post('/api/contacts/audience-preview', {
      filter: { all: [{ tag: tag.name }, { attr: spend, op: 'gt', value: 100 }] },
      templateCategory: 'MARKETING',
    });
    expect(marketing.body).toEqual({ eligible: 1, excluded: { optedOut: 1, noOptIn: 1, invalidNumber: 0, duplicate: 0, missingVariable: 0 } });

    const invalid = await post('/api/contacts/audience-preview', { filter: { all: [{ attr: spend, op: 'contains', value: 'x' }] } });
    expect(invalid.status).toBe(422);
  });

  it('masks phones for agents and keeps writes to permitted roles', async () => {
    const agent = await signIn(ctx, 'AGENT');
    const list = await agent.agent.get('/api/contacts').query({ q: `zubair ${suffix}` });
    expect(list.status).toBe(200);
    expect(list.body.items[0].phone).toMatch(/^•••• \d{4}$/);
    const detail = await agent.agent.get(`/api/contacts/${contactId}`);
    expect(detail.body.phone).toMatch(/^•••• /);
    expect((await post('/api/contacts', { phone: uaePhone() }, agent)).status).toBe(403);
    expect((await post('/api/contacts/bulk', { contactIds: [contactId], action: 'ADD_TAG', tag: 'x' }, agent)).status).toBe(403);
  });
});
