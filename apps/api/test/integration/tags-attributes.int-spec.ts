import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits, seedContact, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T115: tags and custom attribute definitions (FR-009, FR-011).
describe('Tags and attributes', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  const suffix = digits(4);

  const send = (method: 'post' | 'patch' | 'delete', path: string, body?: unknown, who: SignedInAgent = admin) =>
    who.agent[method](path).set('x-csrf-token', who.csrf).send(body as object);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
  });
  afterAll(async () => ctx.close());

  it('creates tags with case-insensitive unique names and lists contact counts', async () => {
    const created = await send('post', '/api/tags', { name: ` Summer-VIP-${suffix} ` });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), name: `summer-vip-${suffix}`, contactCount: 0 });
    expect((await send('post', '/api/tags', { name: `SUMMER-vip-${suffix}` })).status).toBe(409);
    expect((await send('post', '/api/tags', { name: '' })).status).toBe(422);

    const contact = await seedContact(ctx, uaePhone());
    await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: created.body.id } });
    const list = await admin.agent.get('/api/tags');
    expect(list.body.find((t: { id: string }) => t.id === created.body.id)).toMatchObject({ contactCount: 1 });

    expect((await send('delete', `/api/tags/${created.body.id}`)).status).toBe(204);
    expect(await ctx.prisma.contactTag.count({ where: { contactId: contact.id } })).toBe(0);
  });

  it('defines attributes with unique keys and supported types, and renames labels', async () => {
    const key = `orders_${suffix}`;
    const created = await send('post', '/api/attributes', { key, label: 'Orders', type: 'NUMBER' });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ id: expect.any(String), key, label: 'Orders', type: 'NUMBER' });
    expect((await send('post', '/api/attributes', { key, label: 'Again', type: 'TEXT' })).status).toBe(409);
    expect((await send('post', '/api/attributes', { key: 'City Name', label: 'x', type: 'TEXT' })).status).toBe(422);
    expect((await send('post', '/api/attributes', { key: `ok_${suffix}`, label: 'x', type: 'COLOR' })).status).toBe(422);

    const renamed = await send('patch', `/api/attributes/${created.body.id}`, { label: 'Order count' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.label).toBe('Order count');
    expect((await admin.agent.get('/api/attributes')).body).toContainEqual({ id: created.body.id, key, label: 'Order count', type: 'NUMBER' });
  });

  it('deleting an attribute removes its values from contacts', async () => {
    const key = `tier_${suffix}`;
    const other = `note_${suffix}`;
    const created = await send('post', '/api/attributes', { key, label: 'Tier', type: 'TEXT' });
    await send('post', '/api/attributes', { key: other, label: 'Note', type: 'TEXT' });
    const contact = await seedContact(ctx, uaePhone(), { attributes: { [key]: 'gold', [other]: 'keep me' } });

    expect((await send('delete', `/api/attributes/${created.body.id}`)).status).toBe(204);
    const after = await ctx.prisma.contact.findUniqueOrThrow({ where: { id: contact.id } });
    expect(after.attributes).toEqual({ [other]: 'keep me' });
  });

  it('limits attribute definitions to attributes.manage', async () => {
    const agent = await signIn(ctx, 'AGENT');
    expect((await send('post', '/api/attributes', { key: `x_${suffix}`, label: 'x', type: 'TEXT' }, agent)).status).toBe(403);
    expect((await agent.agent.get('/api/attributes')).status).toBe(200);
    const manager = await signIn(ctx, 'MANAGER');
    expect((await send('post', '/api/attributes', { key: `m_${suffix}`, label: 'Manager made', type: 'BOOLEAN' }, manager)).status).toBe(201);
  });
});
