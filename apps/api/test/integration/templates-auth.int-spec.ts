import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { digits, restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T020 (feature 009 US1, research R2, R8): authentication templates through the template routes,
// answered by FakeTemplatesGraph with Meta's rules.
describe('Authentication templates (009 US1)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let wabaId: string;
  let fake: FakeTemplatesGraph;

  const create = (body: object, who: SignedInAgent = manager) => who.agent.post('/api/templates').set('x-csrf-token', who.csrf).send(body);
  const draft = (overrides: Record<string, unknown> = {}) => ({
    wabaId,
    name: `login_code_${digits(6)}`,
    language: 'en_US',
    category: 'AUTHENTICATION',
    kind: 'AUTHENTICATION',
    body: { text: '' },
    ttlSeconds: 300,
    auth: { securityNote: true, codeExpiryMinutes: 10, button: 'COPY_CODE', buttonText: 'Copy code' },
    ...overrides,
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    useNockLocalOnly();
    wabaId = (await seedNumber(ctx)).wabaId;
  });
  afterEach(() => nock.cleanAll());
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('creates and submits a copy-code template with the TTL sent to Meta', async () => {
    fake = new FakeTemplatesGraph().install();
    const body = draft();
    const res = await create(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ kind: 'AUTHENTICATION', category: 'AUTHENTICATION', ttlSeconds: 300, ttlAppliedBy: 'META', status: 'PENDING' });
    expect(fake.creates.at(-1)).toMatchObject({
      name: body.name,
      category: 'AUTHENTICATION',
      message_send_ttl_seconds: 300,
      components: [
        { type: 'BODY', add_security_recommendation: true },
        { type: 'FOOTER', code_expiration_minutes: 10 },
        { type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'COPY_CODE', text: 'Copy code' }] },
      ],
    });
    const row = await ctx.prisma.template.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row).toMatchObject({ kind: 'AUTHENTICATION', ttlSeconds: 300, ttlAppliedBy: 'META' });
    expect(row.options).toMatchObject({ securityNote: true, codeExpiryMinutes: 10, button: 'COPY_CODE' });
  });

  it('needs the apps for one-tap and checks the options before calling Meta', async () => {
    fake = new FakeTemplatesGraph().install();
    const noApps = await create(draft({ auth: { securityNote: false, codeExpiryMinutes: null, button: 'ONE_TAP' } }));
    expect(noApps.status).toBe(422);
    expect(noApps.body.details.map((d: { field: string }) => d.field)).toContain('auth.apps');
    const tooLong = await create(draft({ auth: { securityNote: true, codeExpiryMinutes: 91, button: 'COPY_CODE' } }));
    expect(tooLong.body.details.map((d: { field: string }) => d.field)).toContain('auth.codeExpiryMinutes');
    const badTtl = await create(draft({ ttlSeconds: 901 }));
    expect(badTtl.body.details.map((d: { field: string }) => d.field)).toContain('ttlSeconds');
    expect(fake.creates).toHaveLength(0);

    const oneTap = await create(draft({ auth: { securityNote: false, codeExpiryMinutes: null, button: 'ONE_TAP', apps: [{ packageName: 'com.example.app', signatureHash: 'K8a/AINcGX7' }] } }));
    expect(oneTap.status, JSON.stringify(oneTap.body)).toBe(201);
    expect(fake.creates.at(-1)?.components?.at(-1)).toEqual({ type: 'BUTTONS', buttons: [{ type: 'OTP', otp_type: 'ONE_TAP', supported_apps: [{ package_name: 'com.example.app', signature_hash: 'K8a/AINcGX7' }] }] });
  });

  it('reads the kind back on sync, with Meta storing the button as URL', async () => {
    fake = new FakeTemplatesGraph().install();
    const created = await create(draft());
    expect(created.status).toBe(201);
    const synced = await manager.agent.post('/api/templates/sync').set('x-csrf-token', manager.csrf).send({});
    expect(synced.status, JSON.stringify(synced.body)).toBeLessThan(300);
    const row = await ctx.prisma.template.findUniqueOrThrow({ where: { id: created.body.id } });
    expect(row.kind).toBe('AUTHENTICATION');
    const buttons = (row.components as Array<{ type: string; buttons?: Array<{ type: string }> }>).find((c) => c.type === 'BUTTONS')?.buttons;
    expect(buttons?.[0]?.type).toBe('URL');
  });

  it('is for template managers only', async () => {
    fake = new FakeTemplatesGraph().install();
    expect((await create(draft(), agent)).status).toBe(403);
  });
});
