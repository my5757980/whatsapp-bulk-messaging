import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T026 (feature 006, US2, FR-010 - FR-016, research R4, R5): API key permissions and the contacts,
// tags, attributes, consent and drip enrolment routes of the public API.
describe('Contacts through the public API (006 US2)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let fullKey: string;
  let fullKeyId: string;
  let sendKey: string;

  const dashboard = (method: 'get' | 'post' | 'put', url: string, body?: object) =>
    method === 'get' ? admin.agent.get(`/api${url}`) : admin.agent[method](`/api${url}`).set('X-CSRF-Token', admin.csrf).send(body ?? {});
  const v1 = (key: string, method: 'get' | 'post' | 'patch' | 'delete', url: string, body?: object, idempotencyKey?: string) => {
    let req = request(ctx.server())[method](`/api/v1${url}`).set('Authorization', `Bearer ${key}`);
    if (idempotencyKey) req = req.set('Idempotency-Key', idempotencyKey);
    return method === 'get' ? req : req.send(body ?? {});
  };
  const newKey = async (scopes?: string[]) => {
    const created = await dashboard('post', '/api-keys', { name: uniq('Key '), rateLimitPerMinute: 600 });
    expect(created.status).toBe(201);
    if (scopes) expect((await dashboard('put', `/api-keys/${created.body.id}/scopes`, { scopes })).status).toBe(200);
    return { secret: created.body.secret as string, id: created.body.id as string };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    const full = await newKey(['messages.send', 'contacts.read', 'contacts.write', 'drips.enrol']);
    fullKey = full.secret;
    fullKeyId = full.id;
    sendKey = (await newKey()).secret;
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('gives old keys only "send messages", and refuses other routes with insufficient_scope', async () => {
    const keys = await dashboard('get', '/api-keys');
    const send = (keys.body as Array<{ scopes: string[]; last4: string }>).find((k) => sendKey.endsWith(k.last4));
    expect(send?.scopes).toEqual(['messages.send']);
    for (const [method, url] of [
      ['get', '/contacts'],
      ['post', '/contacts'],
      ['get', '/contacts/lookup?phone=%2B971500000000'],
      ['get', '/tags'],
      ['get', '/attributes'],
    ] as const) {
      const res = await v1(sendKey, method, url, method === 'post' ? { phone: uaePhone() } : undefined);
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body.code).toBe('insufficient_scope');
    }
    // The 001 routes still work for it.
    expect((await v1(sendKey, 'get', '/templates')).status).toBe(200);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'api_key.scopes_changed', targetId: fullKeyId } })).toBe(1);
  });

  it('creates or updates by phone without duplicates, reading local numbers with the default country', async () => {
    const local = `050${String(Date.now()).slice(-7)}`;
    const created = await v1(fullKey, 'post', '/contacts', { phone: local, name: 'Sara', tags: ['crm', 'vip'], attributes: {} });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({ phone: `+971${local.slice(1)}`, name: 'Sara', tags: expect.arrayContaining(['crm', 'vip']), consentStatus: 'UNKNOWN' });
    const again = await v1(fullKey, 'post', '/contacts', { phone: `+971${local.slice(1)}`, name: 'Sara Ali' });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: created.body.id, name: 'Sara Ali' });
    expect(await ctx.prisma.contact.count({ where: { phoneE164: `+971${local.slice(1)}` } })).toBe(1);
    expect((await v1(fullKey, 'post', '/contacts', { phone: '12' })).status).toBe(422);
  });

  it('looks contacts up and lists them in a stable order with a cursor', async () => {
    const tag = uniq('sync').toLowerCase();
    const phones = [uaePhone(), uaePhone(), uaePhone()];
    for (const phone of phones) expect((await v1(fullKey, 'post', '/contacts', { phone, tags: [tag] })).status).toBe(201);
    const found = await v1(fullKey, 'get', `/contacts/lookup?phone=${encodeURIComponent(phones[0]!)}`);
    expect(found.status).toBe(200);
    expect((await v1(fullKey, 'get', `/contacts/${found.body.id}`)).body).toMatchObject({ phone: phones[0] });
    expect((await v1(fullKey, 'get', `/contacts/lookup?phone=${encodeURIComponent(uaePhone())}`)).status).toBe(404);

    const first = await v1(fullKey, 'get', `/contacts?tag=${tag}&limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toBeTruthy();
    const second = await v1(fullKey, 'get', `/contacts?tag=${tag}&limit=2&cursor=${encodeURIComponent(first.body.nextCursor)}`);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();
    const seen = [...first.body.items, ...second.body.items].map((c: { phone: string }) => c.phone).sort();
    expect(seen).toEqual([...phones].sort());
    const since = await v1(fullKey, 'get', `/contacts?tag=${tag}&updatedSince=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`);
    expect(since.body.items).toHaveLength(0);
  });

  it('checks attribute types, removes an attribute with null, and adds and removes tags', async () => {
    await ctx.prisma.attributeDefinition.upsert({ where: { key: 'city' }, create: { key: 'city', label: 'City', type: 'TEXT' }, update: {} });
    await ctx.prisma.attributeDefinition.upsert({ where: { key: 'orders' }, create: { key: 'orders', label: 'Orders', type: 'NUMBER' }, update: {} });
    const contact = await v1(fullKey, 'post', '/contacts', { phone: uaePhone(), attributes: { city: 'Dubai', orders: 3 } });
    expect(contact.status).toBe(201);
    expect((await v1(fullKey, 'patch', `/contacts/${contact.body.id}`, { attributes: { orders: 'many' } })).status).toBe(422);
    const patched = await v1(fullKey, 'patch', `/contacts/${contact.body.id}`, { attributes: { city: null } });
    expect(patched.status).toBe(200);
    expect(patched.body.attributes).toEqual({ orders: 3 });

    const tagged = await v1(fullKey, 'post', `/contacts/${contact.body.id}/tags`, { tags: ['Lead', 'web'] });
    expect(tagged.body.tags).toEqual(expect.arrayContaining(['lead', 'web']));
    const untagged = await v1(fullKey, 'delete', `/contacts/${contact.body.id}/tags/web`);
    expect(untagged.status).toBe(200);
    expect(untagged.body.tags).toEqual(['lead']);
    expect((await v1(fullKey, 'get', '/tags')).body.map((t: { name: string }) => t.name)).toEqual(expect.arrayContaining(['lead', 'web']));
    expect((await v1(fullKey, 'get', '/attributes')).body).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'city', type: 'TEXT' })]));
  });

  it('needs a source note for an opt-in, always takes an opt-out, and shows the key in the journey', async () => {
    const number = await seedNumber(ctx);
    const contact = await seedContact(ctx, uaePhone());
    await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id } });
    expect((await v1(fullKey, 'post', `/contacts/${contact.id}/opt-in`, {})).status).toBe(422);
    const optedIn = await v1(fullKey, 'post', `/contacts/${contact.id}/opt-in`, { sourceNote: 'CRM signup form' });
    expect(optedIn.body.consentStatus).toBe('OPTED_IN');
    expect(await ctx.prisma.consentEvent.findFirst({ where: { contactId: contact.id, status: 'OPTED_IN' } })).toMatchObject({ source: 'API', note: 'CRM signup form' });
    const optedOut = await v1(fullKey, 'post', `/contacts/${contact.id}/opt-out`);
    expect(optedOut.body.consentStatus).toBe('OPTED_OUT');
    expect((await v1(fullKey, 'post', `/contacts/${contact.id}/opt-in`, { sourceNote: 'again' })).status).toBe(409);
    const journey = await ctx.prisma.conversationEvent.findFirst({ where: { conversation: { contactId: contact.id }, type: 'CONSENT_CHANGED', actorType: 'API_KEY' } });
    expect(journey?.data).toMatchObject({ apiKey: { id: fullKeyId } });
  });

  it('answers a repeated idempotency key with the first answer, and limits requests per key', async () => {
    const phone = uaePhone();
    const key = uniq('idem');
    const first = await v1(fullKey, 'post', '/contacts', { phone, name: 'Once' }, key);
    const repeat = await v1(fullKey, 'post', '/contacts', { phone, name: 'Once' }, key);
    expect(first.status).toBe(201);
    expect(repeat.status).toBe(201);
    expect(repeat.body.id).toBe(first.body.id);
    expect((await v1(fullKey, 'post', '/contacts', { phone, name: 'Changed' }, key)).status).toBe(409);

    const limited = await newKey(['contacts.read']);
    await ctx.prisma.apiKey.update({ where: { id: limited.id }, data: { rateLimitPerMinute: 2 } });
    for (let i = 0; i < 2; i += 1) expect((await v1(limited.secret, 'get', '/tags')).status).toBe(200);
    const over = await v1(limited.secret, 'get', '/tags');
    expect(over.status).toBe(429);
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('adds contacts to drips under the drip rules, and raises webhook and drip starting events', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' });
    const name = uniq('API drip ');
    const drip = await ctx.prisma.drip.create({ data: { name, numberId: number.id, status: 'ACTIVE' } });
    await ctx.prisma.dripStep.create({ data: { dripId: drip.id, position: 1, templateId: template.id, waitMinutes: 0 } });
    const contact = await seedContact(ctx, uaePhone());
    const optedOut = await seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_OUT' });

    const joined = await v1(fullKey, 'post', `/drips/${encodeURIComponent(name)}/enrolments`, { contactId: contact.id });
    expect(joined.body).toEqual({ enrolled: true, reason: null });
    expect((await v1(fullKey, 'post', `/drips/${drip.id}/enrolments`, { phone: contact.phoneE164 })).body).toEqual({ enrolled: false, reason: 'already_in' });
    expect((await v1(fullKey, 'post', `/drips/${drip.id}/enrolments`, { contactId: optedOut.id })).body).toEqual({ enrolled: false, reason: 'opted_out' });
    expect((await v1(fullKey, 'post', `/drips/${drip.id}/enrolments`, { phone: uaePhone() })).body).toEqual({ enrolled: false, reason: 'not_found' });
    expect((await v1(fullKey, 'post', '/drips/no-such-drip/enrolments', { contactId: contact.id })).status).toBe(404);
    // Each enrolment request is audited by the key, as in the dashboard (the unknown phone never reached the drip).
    expect(await ctx.prisma.auditLog.count({ where: { action: 'drip.contacts_enrolled', targetId: drip.id, actorApiKeyId: fullKeyId } })).toBe(3);

    expect((await v1(fullKey, 'delete', `/drips/${drip.id}/enrolments/${contact.id}`)).status).toBe(204);
    expect(await ctx.prisma.dripEnrolment.findFirst({ where: { dripId: drip.id, contactId: contact.id } })).toMatchObject({ status: 'LEFT', leftReason: 'REMOVED' });
    expect((await v1(fullKey, 'delete', `/drips/${drip.id}/enrolments/${contact.id}`)).status).toBe(404);

    // Changes through the API raise the same events as the dashboard (FR-016).
    const hook = await dashboard('post', '/webhook-endpoints', { name: uniq('API events '), url: `https://${uniq('api')}.example.test/hooks`, eventTypes: ['contact.created', 'contact.tags_changed'] });
    ctx.app.get(OutboundEvents).invalidate();
    const fresh = await v1(fullKey, 'post', '/contacts', { phone: uaePhone(), tags: ['from-api'] });
    const types = (await ctx.prisma.webhookDelivery.findMany({ where: { endpointId: hook.body.id }, include: { event: true } })).map((d) => d.event.type);
    expect(types).toEqual(expect.arrayContaining(['contact.created', 'contact.tags_changed']));
    expect(fresh.status).toBe(201);
  });
});
