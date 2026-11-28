import request from 'supertest';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { FakeTemplatesGraph } from './fake-templates-graph.js';
import { seedTemplate } from './fixtures.js';
import { uniq, type SignedInAgent, type TestContext } from './test-context.js';

// Feature 009 (T014): helpers for the template kinds, API keys with scopes and code sends.

export const AUTH_COMPONENTS = [
  { type: 'BODY', add_security_recommendation: true },
  { type: 'FOOTER', code_expiration_minutes: 10 },
  { type: 'BUTTONS', buttons: [{ type: 'URL', otp_type: 'COPY_CODE', text: 'Copy code' }] },
];

/** An approved authentication template, known to the fake when one is given. */
export async function seedAuthTemplate(ctx: TestContext, wabaId: string, fake?: FakeTemplatesGraph, overrides: Partial<Prisma.TemplateUncheckedCreateInput> = {}) {
  const name = uniq('login_code_').toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const template = await seedTemplate(ctx, wabaId, {
    name,
    category: 'AUTHENTICATION',
    kind: 'AUTHENTICATION',
    components: AUTH_COMPONENTS as unknown as Prisma.InputJsonValue,
    options: { securityNote: true, codeExpiryMinutes: 10, button: 'COPY_CODE', buttonText: 'Copy code' },
    ttlSeconds: 600,
    ttlAppliedBy: 'META',
    ...overrides,
  });
  fake?.know({ wabaId, name: template.name, language: template.language, category: 'AUTHENTICATION', components: AUTH_COMPONENTS });
  return template;
}

/** An API key with the given scopes; returns its secret. */
export async function apiKeyWithScopes(ctx: TestContext, admin: SignedInAgent, scopes: string[]): Promise<string> {
  const created = await admin.agent.post('/api/api-keys').set('X-CSRF-Token', admin.csrf).send({ name: uniq('Key '), rateLimitPerMinute: 600 });
  if (created.status !== 201) throw new Error(`api key: ${created.status} ${JSON.stringify(created.body)}`);
  const scoped = await admin.agent.put(`/api/api-keys/${created.body.id}/scopes`).set('X-CSRF-Token', admin.csrf).send({ scopes });
  if (scoped.status !== 200) throw new Error(`api key scopes: ${scoped.status} ${JSON.stringify(scoped.body)}`);
  return String(created.body.secret);
}

/** POST /api/v1/otp with a key. */
export function sendCode(ctx: TestContext, key: string, body: Record<string, unknown>, idempotencyKey?: string) {
  const req = request(ctx.server()).post('/api/v1/otp').set('Authorization', `Bearer ${key}`);
  return (idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req).send(body);
}

/** GET /api/v1/otp/{id} with a key. */
export function codeStatus(ctx: TestContext, key: string, id: string) {
  return request(ctx.server()).get(`/api/v1/otp/${id}`).set('Authorization', `Bearer ${key}`);
}
