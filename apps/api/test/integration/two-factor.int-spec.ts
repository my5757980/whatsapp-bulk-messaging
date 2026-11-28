import { createHash } from 'node:crypto';
import argon2 from 'argon2';
import type { Redis } from 'ioredis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { totpCode } from '../../src/common/auth/totp.js';
import { REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T065 (feature 010 US6, FR-025 – FR-030, research R10, contracts/login-2fa.md): two-factor sign-in.
const PASSWORD = 'Two-Factor-Password-12';
type Agent = ReturnType<typeof request.agent>;

describe('Two-factor sign-in (010 US6)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  const secrets = new Map<string, string>();

  const cookieOf = (res: request.Response, name: string): string | null => {
    const raw = ((res.headers['set-cookie'] as unknown as string[] | undefined) ?? []).find((c) => c.startsWith(`${name}=`));
    return raw ? decodeURIComponent(raw.split(';')[0]!.slice(name.length + 1)) : null;
  };
  const member = async (role: 'ADMIN' | 'MANAGER' | 'AGENT' = 'AGENT') => {
    const email = `tfa-${Math.random().toString(36).slice(2, 10)}@test.local`;
    const user = await ctx.prisma.user.create({ data: { email, name: 'Two Factor', role, status: 'ACTIVE', passwordHash: await argon2.hash(PASSWORD, { type: argon2.argon2id }) } });
    return { id: user.id, email };
  };
  const passwordStep = (agent: Agent, email: string) => agent.post('/api/auth/login').send({ email, password: PASSWORD });
  /** A signed-in agent with its CSRF token (password only; for members without a second step). */
  const signedIn = async (email: string) => {
    const agent = request.agent(ctx.server());
    const res = await passwordStep(agent, email);
    expect(res.status).toBe(200);
    expect(res.body.id).toBeDefined();
    return { agent, csrf: cookieOf(res, 'csrf')! };
  };
  const post = (who: { agent: Agent; csrf: string }, path: string, body: object = {}) => who.agent.post(`/api${path}`).set('X-CSRF-Token', who.csrf).send(body);
  /** The code for now (+ steps), which the member's app would show. */
  const code = (userId: string, steps = 0) => totpCode(secrets.get(userId)!, Date.now() + steps * 30_000);
  /** Lets the next code be accepted again in tests (a real app waits 30 seconds). */
  const forgetLastStep = (userId: string) => ctx.prisma.userTwoFactor.update({ where: { userId }, data: { lastStep: null } });
  const turnOn = async (who: { agent: Agent; csrf: string }, userId: string) => {
    const setup = await post(who, '/me/2fa/setup');
    expect(setup.status, JSON.stringify(setup.body)).toBe(200);
    expect(setup.body.otpauthUrl).toMatch(/^otpauth:\/\/totp\//);
    expect(setup.body.qrSvg).toContain('<svg');
    secrets.set(userId, setup.body.secret as string);
    const confirmed = await post(who, '/me/2fa/confirm', { code: code(userId) });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    return confirmed.body.recoveryCodes as string[];
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
  });

  afterAll(async () => {
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { require2fa: false } });
    await ctx.close();
  });

  it('turns 2FA on and off, with recovery codes shown once and replaced on request', async () => {
    const m = await member();
    const who = await signedIn(m.email);
    expect((await who.agent.get('/api/me/2fa')).body).toEqual({ enabled: false, enabledAt: null, required: false, recoveryCodesLeft: 0 });

    const wrongSetup = await post(who, '/me/2fa/confirm', { code: '000000' });
    expect(wrongSetup.body.code).toBe('NO_SETUP');
    const codes = await turnOn(who, m.id);
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect((await who.agent.get('/api/me/2fa')).body).toMatchObject({ enabled: true, required: false, recoveryCodesLeft: 10 });
    expect((await post(who, '/me/2fa/setup')).body.code).toBe('ALREADY_ENABLED');
    // Stored as keyed hashes only.
    const stored = await ctx.prisma.userRecoveryCode.findMany({ where: { userId: m.id } });
    expect(stored.every((r) => /^[0-9a-f]{64}$/.test(r.codeHash) && !codes.includes(r.codeHash))).toBe(true);
    expect((await ctx.prisma.userTwoFactor.findUniqueOrThrow({ where: { userId: m.id } })).secretEnc).not.toContain(secrets.get(m.id)!);

    const fresh = await post(who, '/me/2fa/recovery-codes', { code: code(m.id, 1) });
    expect(fresh.status).toBe(200);
    expect(fresh.body.recoveryCodes.some((c: string) => codes.includes(c))).toBe(false);
    await forgetLastStep(m.id);
    expect((await post(who, '/me/2fa/disable', { code: '123456' })).body.code).toBe('INVALID_CODE');
    expect((await post(who, '/me/2fa/disable', { code: code(m.id) })).status).toBe(204);
    expect((await who.agent.get('/api/me/2fa')).body.enabled).toBe(false);
    expect(await ctx.prisma.userRecoveryCode.count({ where: { userId: m.id } })).toBe(0);
  });

  it('asks for a code after the password; a code or a recovery code signs in', async () => {
    const m = await member();
    const codes = await turnOn(await signedIn(m.email), m.id);

    const agent = request.agent(ctx.server());
    const first = await passwordStep(agent, m.email);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ next: 'CODE' });
    expect(cookieOf(first, 'sid')).toBeNull();
    expect(cookieOf(first, 'sid_2fa')).toBeTruthy();
    expect((await agent.get('/api/auth/me')).status).toBe(401);

    expect((await agent.post('/api/auth/login/code').send({ code: '000000' })).body.code).toBe('INVALID_CODE');
    const ok = await agent.post('/api/auth/login/code').send({ code: code(m.id, 1) });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(ok.body).toMatchObject({ id: m.id, email: m.email });
    expect(cookieOf(ok, 'sid')).toBeTruthy();
    expect((await agent.get('/api/auth/me')).status).toBe(200);
    // The pending sign-in was used up.
    expect((await agent.post('/api/auth/login/code').send({ code: code(m.id) })).body.code).toBe('PENDING_SIGN_IN_EXPIRED');

    // A recovery code works once, in any case and with spaces.
    const again = request.agent(ctx.server());
    await passwordStep(again, m.email);
    const recovered = await again.post('/api/auth/login/code').send({ recoveryCode: codes[0]!.toLowerCase().replace('-', ' ') });
    expect(recovered.status, JSON.stringify(recovered.body)).toBe(200);
    expect(recovered.body.recoveryCodesLeft).toBe(9);
    const third = request.agent(ctx.server());
    await passwordStep(third, m.email);
    expect((await third.post('/api/auth/login/code').send({ recoveryCode: codes[0] })).body.code).toBe('INVALID_CODE');

    const actions = (await ctx.prisma.auditLog.findMany({ where: { targetId: m.id }, select: { action: true, metadata: true } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['auth.2fa_enabled', 'auth.2fa_failed', 'auth.2fa_recovery_used', 'auth.login']));
    // No code, secret or recovery code in audit details.
    const details = JSON.stringify(await ctx.prisma.auditLog.findMany({ where: { targetId: m.id }, select: { metadata: true } }));
    for (const secretish of [secrets.get(m.id)!, ...codes, codes[0]!.replace('-', '')]) expect(details).not.toContain(secretish);
  });

  it('locks the second step for 15 minutes after five wrong codes', async () => {
    const m = await member();
    await turnOn(await signedIn(m.email), m.id);
    const agent = request.agent(ctx.server());
    await passwordStep(agent, m.email);
    for (let i = 0; i < 4; i++) expect((await agent.post('/api/auth/login/code').send({ code: '000000' })).status).toBe(422);
    const locked = await agent.post('/api/auth/login/code').send({ code: '000000' });
    expect(locked.status).toBe(429);
    expect(locked.body.code).toBe('SECOND_STEP_LOCKED');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThan(800);
    expect(await ctx.prisma.auditLog.count({ where: { targetId: m.id, action: 'auth.2fa_locked' } })).toBe(1);

    // Even the right code waits for the lock; a new pending sign-in is refused too.
    const next = request.agent(ctx.server());
    await passwordStep(next, m.email);
    const refused = await next.post('/api/auth/login/code').send({ code: code(m.id, 1) });
    expect(refused.status).toBe(429);
    expect(refused.headers['retry-after']).toBeDefined();
  });

  it('expires a pending sign-in after 5 minutes', async () => {
    const m = await member();
    await turnOn(await signedIn(m.email), m.id);
    const agent = request.agent(ctx.server());
    const first = await passwordStep(agent, m.email);
    const token = cookieOf(first, 'sid_2fa')!;
    const redis = ctx.app.get<Redis>(REDIS_CLIENT);
    const key = `wbm:login2fa:${createHash('sha256').update(token).digest('hex')}`;
    expect(await redis.ttl(key)).toBeGreaterThan(290);
    await redis.del(key);
    expect((await agent.post('/api/auth/login/code').send({ code: code(m.id, 1) })).body.code).toBe('PENDING_SIGN_IN_EXPIRED');
  });

  it('makes members without 2FA set it up at sign-in when the company requires it', async () => {
    const m = await member('MANAGER');
    const security = await admin.agent.put('/api/settings/security').set('X-CSRF-Token', admin.csrf).send({ require2fa: true });
    expect(security.status).toBe(200);
    expect(security.body.require2fa).toBe(true);
    expect(security.body.members).toEqual(expect.arrayContaining([expect.objectContaining({ userId: m.id, twoFactorEnabled: false })]));
    try {
      const agent = request.agent(ctx.server());
      const first = await passwordStep(agent, m.email);
      expect(first.body).toEqual({ next: 'SETUP' });
      expect((await agent.get('/api/auth/me')).status).toBe(401);
      const setup = await agent.post('/api/auth/login/setup');
      expect(setup.status, JSON.stringify(setup.body)).toBe(200);
      secrets.set(m.id, setup.body.secret as string);
      const confirmed = await agent.post('/api/auth/login/setup/confirm').send({ code: code(m.id) });
      expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
      expect(confirmed.body.recoveryCodes).toHaveLength(10);
      expect((await agent.get('/api/auth/me')).status).toBe(200);
      // Turning it off is refused while it is required.
      const csrf = cookieOf(confirmed, 'csrf')!;
      await forgetLastStep(m.id);
      expect((await agent.post('/api/me/2fa/disable').set('X-CSRF-Token', csrf).send({ code: code(m.id) })).body.code).toBe('TWO_FACTOR_REQUIRED');
      expect(await ctx.prisma.auditLog.count({ where: { action: 'security.2fa_required_changed', actorUserId: admin.userId } })).toBeGreaterThanOrEqual(1);
      // API keys never sign in, so they keep working (FR-030).
      const key = await admin.agent.post('/api/api-keys').set('X-CSRF-Token', admin.csrf).send({ name: `2FA key ${Date.now()}`, rateLimitPerMinute: 60 });
      expect(key.status).toBe(201);
      expect((await request(ctx.server()).get('/api/v1/templates').set('authorization', `Bearer ${key.body.secret}`)).status).toBe(200);
    } finally {
      await admin.agent.put('/api/settings/security').set('X-CSRF-Token', admin.csrf).send({ require2fa: false });
    }
  });

  it("lets an admin reset another member's 2FA, ending their sessions, but not their own", async () => {
    const m = await member();
    const who = await signedIn(m.email);
    await turnOn(who, m.id);
    expect((await who.agent.get('/api/auth/me')).status).toBe(200);
    const agentRole = await signIn(ctx, 'AGENT');
    expect((await agentRole.agent.post(`/api/users/${m.id}/2fa/reset`).set('X-CSRF-Token', agentRole.csrf)).status).toBe(403);
    expect((await admin.agent.post(`/api/users/${admin.userId}/2fa/reset`).set('X-CSRF-Token', admin.csrf)).body.code).toBe('CANNOT_RESET_SELF');
    expect((await admin.agent.post(`/api/users/${m.id}/2fa/reset`).set('X-CSRF-Token', admin.csrf)).status).toBe(204);
    expect((await who.agent.get('/api/auth/me')).status).toBe(401);
    expect(await ctx.prisma.userTwoFactor.count({ where: { userId: m.id } })).toBe(0);
    expect(await ctx.prisma.auditLog.count({ where: { targetId: m.id, action: 'auth.2fa_reset' } })).toBe(1);
    // Without 2FA and no requirement, the password alone signs in again.
    expect((await passwordStep(request.agent(ctx.server()), m.email)).body.id).toBe(m.id);
  });
});
