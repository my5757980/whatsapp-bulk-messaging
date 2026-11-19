import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/modules/auth/auth.service.js';
import { MailerService } from '../../src/modules/users/mailer.service.js';
import { digits } from '../support/fixtures.js';
import { TEST_PASSWORD, createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T166: invitations, role and status changes, and the last-admin guard (FR-005, FR-006).
describe('Team members', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  const sent: Array<{ to: string; inviteUrl: string }> = [];
  const fakeMailer = {
    enabled: true,
    sendInvitation: async (to: string, inviteUrl: string) => {
      sent.push({ to, inviteUrl });
      return true;
    },
  };

  const invite = (email: string, role: string) => admin.agent.post('/api/users/invitations').set('x-csrf-token', admin.csrf).send({ email, role });
  const patch = (id: string, body: unknown, who: SignedInAgent = admin) => who.agent.patch(`/api/users/${id}`).set('x-csrf-token', who.csrf).send(body as object);
  const tokenOf = (inviteUrl: string) => inviteUrl.split('/invite/')[1] as string;

  beforeAll(async () => {
    ctx = await createTestContext([[MailerService, fakeMailer]]);
    admin = await signIn(ctx, 'ADMIN');
  });
  afterAll(async () => ctx.close());

  it('invites by email with a single-use link and lets the invitee set a password', async () => {
    const email = `New.Member.${digits(5)}@Company.test`;
    const res = await invite(email, 'MANAGER');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ emailed: true, inviteUrl: expect.stringMatching(/^http.+\/invite\/[\w-]{20,}$/) });
    expect(new Date(res.body.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(sent.at(-1)).toEqual({ to: email.toLowerCase(), inviteUrl: res.body.inviteUrl });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'user.invited', actorUserId: admin.userId } })).toBeGreaterThanOrEqual(1);

    const token = tokenOf(res.body.inviteUrl);
    const stored = await ctx.prisma.invitation.findFirstOrThrow({ where: { email: email.toLowerCase() } });
    expect(stored.tokenHash).toBe(hashToken(token)); // only the hash is stored

    const server = ctx.server();
    const check = await request(server).get(`/api/auth/invitations/${token}`);
    expect(check.status).toBe(200);
    expect(check.body).toEqual({ email: email.toLowerCase(), role: 'MANAGER' });

    expect((await request(server).post(`/api/auth/invitations/${token}/accept`).send({ name: 'New Member', password: 'short' })).status).toBe(422);

    const invitee = request.agent(server);
    const accepted = await invitee.post(`/api/auth/invitations/${token}/accept`).send({ name: 'New Member', password: TEST_PASSWORD });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ email: email.toLowerCase(), name: 'New Member', role: 'MANAGER', status: 'ACTIVE' });
    expect((await invitee.get('/api/auth/me')).body.permissions).toContain('campaigns.launch');

    expect((await request(server).get(`/api/auth/invitations/${token}`)).status).toBe(404); // single use
    expect((await request(server).post(`/api/auth/invitations/${token}/accept`).send({ name: 'Again', password: TEST_PASSWORD })).status).toBe(404);
  });

  it('rejects expired invitations and invitations for existing members', async () => {
    const email = `late.${digits(5)}@company.test`;
    const res = await invite(email, 'AGENT');
    await ctx.prisma.invitation.updateMany({ where: { email }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await request(ctx.server()).get(`/api/auth/invitations/${tokenOf(res.body.inviteUrl)}`)).status).toBe(404);

    const existing = await ctx.prisma.user.findUniqueOrThrow({ where: { id: admin.userId } });
    expect((await invite(existing.email, 'AGENT')).status).toBe(409);
    expect((await invite('not-an-email', 'AGENT')).status).toBe(422);
  });

  it('lists members, changes roles and deactivates with session revocation', async () => {
    const member = await signIn(ctx, 'AGENT');
    const list = await admin.agent.get('/api/users');
    expect(list.status).toBe(200);
    expect(list.body.find((u: { id: string }) => u.id === member.userId)).toMatchObject({ role: 'AGENT', status: 'ACTIVE' });

    const promoted = await patch(member.userId, { role: 'MANAGER' });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('MANAGER');
    expect((await member.agent.get('/api/auth/me')).body.role).toBe('MANAGER'); // applies immediately

    expect((await patch(member.userId, { status: 'DEACTIVATED' })).status).toBe(200);
    expect((await member.agent.get('/api/auth/me')).status).toBe(401); // sessions revoked
    expect((await patch(member.userId, { status: 'ACTIVE' })).status).toBe(200);

    for (const action of ['user.role_changed', 'user.deactivated', 'user.reactivated']) {
      expect(await ctx.prisma.auditLog.count({ where: { action, targetId: member.userId } })).toBe(1);
    }
    const manager = await signIn(ctx, 'MANAGER');
    expect((await patch(member.userId, { role: 'ADMIN' }, manager)).status).toBe(403);
  });

  it('protects the last active admin', async () => {
    await ctx.prisma.user.updateMany({ where: { role: 'ADMIN', id: { not: admin.userId } }, data: { status: 'DEACTIVATED' } });
    expect((await patch(admin.userId, { role: 'MANAGER' })).status).toBe(409);
    expect((await patch(admin.userId, { status: 'DEACTIVATED' })).status).toBe(409);
    const second = await signIn(ctx, 'ADMIN');
    expect((await patch(admin.userId, { role: 'MANAGER' }, second)).status).toBe(200);
  });
});
