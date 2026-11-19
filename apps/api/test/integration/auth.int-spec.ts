import type { INestApplication } from '@nestjs/common';
import argon2 from 'argon2';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { createTestApp } from '../support/create-app.js';

// T042: login / logout / me, CSRF, idle and absolute expiry, throttling (ADR-0005).
const PASSWORD = 'Correct-Horse-Battery-12'; // gitleaks:allow - test-only password

function cookieValue(res: request.Response, name: string): string | undefined {
  const raw = res.headers['set-cookie'] as unknown as string[] | undefined;
  const found = raw?.find((c) => c.startsWith(`${name}=`));
  return found?.split(';')[0]?.slice(name.length + 1);
}

describe('auth', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    await prisma.user.createMany({
      data: [
        { email: 'admin@auth.test', name: 'Admin', role: 'ADMIN', status: 'ACTIVE', passwordHash },
        { email: 'gone@auth.test', name: 'Gone', role: 'MANAGER', status: 'DEACTIVATED', passwordHash },
        { email: 'throttle@auth.test', name: 'Throttle', role: 'AGENT', status: 'ACTIVE', passwordHash },
      ],
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const login = (agent: ReturnType<typeof request.agent>, email: string, password = PASSWORD) =>
    agent.post('/api/auth/login').send({ email, password });

  it('signs in, sets the session and CSRF cookies, and returns the user', async () => {
    const agent = request.agent(app.getHttpServer());
    const res = await login(agent, 'Admin@Auth.test');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email: 'admin@auth.test', role: 'ADMIN', status: 'ACTIVE' });
    const cookies = (res.headers['set-cookie'] as unknown as string[]).join('\n');
    expect(cookies).toMatch(/sid=[^;]+;.*HttpOnly/i);
    expect(cookieValue(res, 'csrf')).toBeTruthy();

    const me = await agent.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.permissions).toContain('audit.view');
  });

  it('rejects a wrong password and a deactivated user with 401', async () => {
    const agent = request.agent(app.getHttpServer());
    expect((await login(agent, 'admin@auth.test', 'wrong-password-123')).status).toBe(401);
    const res = await login(agent, 'gone@auth.test');
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('requires the CSRF header to log out, then the session is gone', async () => {
    const agent = request.agent(app.getHttpServer());
    const res = await login(agent, 'admin@auth.test');
    const csrf = cookieValue(res, 'csrf') as string;

    const noHeader = await agent.post('/api/auth/logout');
    expect(noHeader.status).toBe(403);
    expect(noHeader.body).toMatchObject({ code: 'CSRF_FAILED' });

    expect((await agent.post('/api/auth/logout').set('X-CSRF-Token', csrf)).status).toBe(204);
    expect((await agent.get('/api/auth/me')).status).toBe(401);
  });

  it('expires sessions after 12 h idle and after 7 days absolute', async () => {
    const idle = request.agent(app.getHttpServer());
    await login(idle, 'admin@auth.test');
    const user = await prisma.user.findUniqueOrThrow({ where: { email: 'admin@auth.test' } });
    await prisma.session.updateMany({
      where: { userId: user.id },
      data: { lastSeenAt: new Date(Date.now() - 13 * 3600 * 1000) },
    });
    expect((await idle.get('/api/auth/me')).status).toBe(401);

    const absolute = request.agent(app.getHttpServer());
    await login(absolute, 'admin@auth.test');
    await prisma.session.updateMany({ where: { userId: user.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await absolute.get('/api/auth/me')).status).toBe(401);
  });

  it('throttles after 10 failed attempts with 429', async () => {
    const agent = request.agent(app.getHttpServer());
    for (let i = 0; i < 10; i++) {
      expect((await login(agent, 'throttle@auth.test', 'bad-password-xyz')).status).toBe(401);
    }
    const blocked = await login(agent, 'throttle@auth.test');
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('throttles per client IP forwarded by the web proxy, so one attacker cannot lock others out', async () => {
    const passwordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id });
    await prisma.user.create({ data: { email: 'proxied@auth.test', name: 'Proxied', role: 'AGENT', status: 'ACTIVE', passwordHash } });
    const from = (ip: string, password = PASSWORD) =>
      request(app.getHttpServer()).post('/api/auth/login').set('x-forwarded-for', ip).send({ email: 'proxied@auth.test', password });
    for (let i = 0; i < 10; i++) expect((await from('203.0.113.7', 'bad-password-xyz')).status).toBe(401);
    expect((await from('203.0.113.7')).status).toBe(429);
    expect((await from('198.51.100.9')).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'auth.login_failed', ip: '203.0.113.7' } })).toBe(10);
  });

  it('records sign-ins in the audit log', async () => {
    const entries = await prisma.auditLog.findMany({ where: { action: { in: ['auth.login', 'auth.login_failed'] } } });
    expect(entries.length).toBeGreaterThan(0);
  });
});
