import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T181: API keys - the secret is shown once and only its hash is stored (FR-032).
describe('API keys', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  const post = (body: unknown, who: SignedInAgent = admin) => who.agent.post('/api/api-keys').set('x-csrf-token', who.csrf).send(body as object);

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
  });
  afterAll(async () => ctx.close());

  it('creates a key, shows the secret once and stores only its hash', async () => {
    const res = await post({ name: 'Website checkout', rateLimitPerMinute: 120 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Website checkout', rateLimitPerMinute: 120, revokedAt: null, lastUsedAt: null });
    const secret = res.body.secret as string;
    expect(secret).toMatch(/^wbk_[A-Za-z0-9]{32}$/);
    expect(res.body.last4).toBe(secret.slice(-4));

    const row = await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.keyHash).toBe(createHash('sha256').update(secret).digest('hex'));
    expect(row.prefix).toBe(secret.slice(0, 8));
    expect(JSON.stringify(row)).not.toContain(secret);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'api_key.created', targetId: res.body.id } })).toBe(1);

    const list = await admin.agent.get('/api/api-keys');
    expect(list.status).toBe(200);
    const listed = list.body.find((k: { id: string }) => k.id === res.body.id);
    expect(listed).toMatchObject({ name: 'Website checkout', last4: secret.slice(-4) });
    expect(listed).not.toHaveProperty('secret');
    expect(JSON.stringify(list.body)).not.toContain(secret);
  });

  it('validates input and revokes keys', async () => {
    expect((await post({})).status).toBe(422);
    expect((await post({ name: 'x', rateLimitPerMinute: 0 })).status).toBe(422);
    const created = await post({ name: 'To revoke' });
    expect(created.body.rateLimitPerMinute).toBe(60);
    const revoked = await admin.agent.delete(`/api/api-keys/${created.body.id}`).set('x-csrf-token', admin.csrf);
    expect(revoked.status).toBe(204);
    expect((await ctx.prisma.apiKey.findUniqueOrThrow({ where: { id: created.body.id } })).revokedAt).toBeTruthy();
    expect(await ctx.prisma.auditLog.count({ where: { action: 'api_key.revoked', targetId: created.body.id } })).toBe(1);
    expect((await admin.agent.delete('/api/api-keys/0190a000-0000-7000-8000-000000000000').set('x-csrf-token', admin.csrf)).status).toBe(404);
  });

  it('is admin-only', async () => {
    const manager = await signIn(ctx, 'MANAGER');
    expect((await post({ name: 'nope' }, manager)).status).toBe(403);
    expect((await manager.agent.get('/api/api-keys')).status).toBe(403);
  });
});
