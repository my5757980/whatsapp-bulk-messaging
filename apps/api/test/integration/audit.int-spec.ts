import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { digits } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T169: audited actions are written, and only admins can read the audit log (FR-008).
describe('Audit log', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
  });
  afterAll(async () => ctx.close());

  it('records sign-in, failed sign-in, sign-out and settings changes', async () => {
    const member = await signIn(ctx, 'MANAGER');
    const email = (await ctx.prisma.user.findUniqueOrThrow({ where: { id: member.userId } })).email;
    await request(ctx.server()).post('/api/auth/login').send({ email, password: 'definitely-wrong-password' });
    await member.agent.post('/api/auth/logout').set('x-csrf-token', member.csrf);
    await admin.agent.patch('/api/settings').set('x-csrf-token', admin.csrf).send({ defaultTimezone: 'Asia/Dubai' });

    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.login', actorUserId: member.userId } })).toBe(1);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'auth.logout', actorUserId: member.userId } })).toBe(1);
    const failed = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.login_failed' }, orderBy: { createdAt: 'desc' } });
    expect(failed.metadata).toMatchObject({ email });
    expect(JSON.stringify(failed.metadata)).not.toContain('definitely-wrong-password');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'settings.updated', actorUserId: admin.userId } })).toBeGreaterThanOrEqual(1);
  });

  it('lists entries newest first with actor names, filters and pagination', async () => {
    const invited = await admin.agent.post('/api/users/invitations').set('x-csrf-token', admin.csrf).send({ email: `audit.${digits(5)}@company.test`, role: 'AGENT' });
    expect(invited.status).toBe(201);

    const res = await admin.agent.get('/api/audit-logs').query({ action: 'user.invited', actorUserId: admin.userId });
    expect(res.status).toBe(200);
    expect(res.body.items[0]).toMatchObject({ action: 'user.invited', actorType: 'USER', actorName: 'ADMIN user', targetType: 'user' });
    expect(res.body.items.every((e: { action: string }) => e.action === 'user.invited')).toBe(true);

    const page = await admin.agent.get('/api/audit-logs').query({ pageSize: 2, page: 1 });
    expect(page.body.items).toHaveLength(2);
    expect(page.body.page).toMatchObject({ page: 1, pageSize: 2 });
    expect(page.body.page.total).toBeGreaterThan(2);
    const [first, second] = page.body.items as Array<{ createdAt: string }>;
    expect(new Date(first!.createdAt).getTime()).toBeGreaterThanOrEqual(new Date(second!.createdAt).getTime());

    const system = await admin.agent.get('/api/audit-logs').query({ action: 'auth.login_failed' });
    expect(system.body.items[0]).toMatchObject({ actorType: 'SYSTEM', actorName: null });
  });

  it('is admin-only', async () => {
    const manager = await signIn(ctx, 'MANAGER');
    expect((await manager.agent.get('/api/audit-logs')).status).toBe(403);
  });
});
