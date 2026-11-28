import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { campaignSendJob } from '../../src/modules/sending/send-jobs.js';
import { sendJobId } from '../../src/modules/sending/dispatch-planner.js';
import { OTP_SETTINGS_ID } from '../../src/modules/otp/otp.service.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { apiKeyWithScopes, codeStatus, seedAuthTemplate, sendCode } from '../support/templates.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T021 (feature 009 US1, research R3 - R5, contracts/public-otp-v1.openapi.yaml): one-time codes through
// the public API: settings, scope, checks, the per-phone limit, idempotency, priority, statuses.

describe('One-time codes API (009 US1)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let fake: FakeTemplatesGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let template: Awaited<ReturnType<typeof seedAuthTemplate>>;
  let key: string;
  let endpointId: string;

  const settings = (body: object) => admin.agent.put('/api/otp/settings').set('X-CSRF-Token', admin.csrf).send(body);
  const jobOf = async (messageId: string) => ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(sendJobId(messageId));
  /** Runs the queued job as the worker would. */
  const run = async (messageId: string) => {
    const job = await jobOf(messageId);
    return ctx.app.get(SendProcessor).process(messageId, 1, (job?.data as { codeEnc?: string } | undefined)?.codeEnc);
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    number = await seedNumber(ctx);
    fake = new FakeTemplatesGraph().install();
    template = await seedAuthTemplate(ctx, number.wabaId, fake);
    key = await apiKeyWithScopes(ctx, admin, ['otp.send']);
    const endpoint = await admin.agent
      .post('/api/webhook-endpoints')
      .set('X-CSRF-Token', admin.csrf)
      .send({ name: uniq('Codes hook '), url: `https://${uniq('otp')}.example.test/hooks`, eventTypes: ['otp.status'] });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    endpointId = endpoint.body.id as string;
    ctx.app.get(OutboundEvents).invalidate();
  });

  beforeEach(async () => {
    expect((await settings({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 5, limitWindowMinutes: 15 })).status).toBe(200);
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await ctx.prisma.webhookEndpoint.delete({ where: { id: endpointId } }).catch(() => undefined);
    await ctx.close();
  });

  it('keeps settings that name an approved code template and a connected number, audited', async () => {
    const marketing = await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' });
    const bad = await settings({ defaultTemplateId: marketing.id, defaultNumberId: number.id, limitPerPhone: 5, limitWindowMinutes: 15 });
    expect(bad.status).toBe(422);
    expect(bad.body.code).toBe('TEMPLATE_NOT_AUTHENTICATION');
    const got = await admin.agent.get('/api/otp/settings');
    expect(got.body).toMatchObject({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 5, limitWindowMinutes: 15, last24h: { requested: expect.any(Number) } });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'otp_settings.changed' } })).toBeGreaterThan(0);
  });

  it('reads and saves one settings row, even when another row exists (e2e US1 regression)', async () => {
    const stray = await ctx.prisma.otpSettings.create({ data: { limitPerPhone: 1 } });
    try {
      expect((await settings({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 7, limitWindowMinutes: 15 })).status).toBe(200);
      expect((await admin.agent.get('/api/otp/settings')).body).toMatchObject({ defaultTemplateId: template.id, limitPerPhone: 7 });
      const sent = await sendCode(ctx, key, { to: uaePhone(), code: '135790' });
      expect(sent.status, JSON.stringify(sent.body)).toBe(202);
      expect((await ctx.prisma.otpSettings.findUniqueOrThrow({ where: { id: OTP_SETTINGS_ID } })).defaultTemplateId).toBe(template.id);
    } finally {
      await ctx.prisma.otpSettings.delete({ where: { id: stray.id } });
    }
  });

  it('accepts a code at once, sends it ahead of campaigns, and never keeps the code', async () => {
    const phone = uaePhone();
    // 3 campaign jobs already wait on the number's queue (priority 10).
    const campaign = await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' });
    for (let i = 0; i < 3; i++) {
      const m = await ctx.prisma.message.create({ data: { origin: 'API', phoneE164: uaePhone(), recipientCountry: 'AE', numberId: number.id, templateId: campaign.id, status: 'QUEUED' } });
      const job = campaignSendJob(m.id);
      await ctx.app.get(QueueRegistry).sendQueue(number.id).add(job.name, job.data, job.opts);
    }
    const res = await sendCode(ctx, key, { to: phone, code: '482913' });
    expect(res.status, JSON.stringify(res.body)).toBe(202);
    expect(res.body).toEqual({ id: expect.any(String), status: 'queued' });
    const job = await jobOf(res.body.id);
    expect(job?.opts.priority ?? 0).toBe(0);
    expect(await job?.getState()).toBe('waiting');
    expect(JSON.stringify(job?.data)).not.toContain('482913');

    const message = await ctx.prisma.message.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(message).toMatchObject({ origin: 'OTP', contactId: null, phoneE164: phone, status: 'QUEUED' });
    expect(JSON.stringify(message.resolvedParams)).not.toContain('482913');
    expect(await ctx.prisma.contact.count({ where: { phoneE164: phone } })).toBe(0);

    expect((await run(res.body.id)).result).toBe('sent');
    const sent = fake.sentTo(phone).at(-1)!;
    expect(sent.body.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: '482913' }] },
      { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: '482913' }] },
    ]);
    const after = await ctx.prisma.message.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(after.status).toBe('SENT');
    expect(after.expiresAt?.getTime()).toBeGreaterThan(Date.now());
  });

  it('needs the otp.send scope, and a code-only key sends nothing else', async () => {
    const messagesKey = await apiKeyWithScopes(ctx, admin, ['messages.send']);
    const refused = await sendCode(ctx, messagesKey, { to: uaePhone(), code: '123456' });
    expect(refused.status).toBe(403);
    const other = await ctx.prisma.template.findFirstOrThrow({ where: { wabaId: number.wabaId, kind: 'STANDARD', status: 'APPROVED' } });
    const viaMessages = await request(ctx.server()).post('/api/v1/messages').set('Authorization', `Bearer ${key}`).send({ to: uaePhone(), template: { name: other.name, language: other.language }, params: { 'BODY.1': 'x' } });
    expect(viaMessages.status).toBe(403);
  });

  it('checks the code, the number, blocked recipients, and sends to people who opted out of marketing', async () => {
    expect((await sendCode(ctx, key, { to: uaePhone(), code: '12 34' })).status).toBe(422);
    expect((await sendCode(ctx, key, { to: uaePhone(), code: '1234567890123456' })).status).toBe(422);
    const invalid = await sendCode(ctx, key, { to: '12', code: '123456' });
    expect(invalid.body.code).toBe('INVALID_NUMBER');
    const blockedPhone = uaePhone();
    await seedContact(ctx, blockedPhone, { blockedAt: new Date() });
    expect((await sendCode(ctx, key, { to: blockedPhone, code: '123456' })).body.code).toBe('RECIPIENT_BLOCKED');
    const optedOut = uaePhone();
    const contact = await seedContact(ctx, optedOut, { consentStatus: 'OPTED_OUT' });
    const ok = await sendCode(ctx, key, { to: optedOut, code: '123456' });
    expect(ok.status).toBe(202);
    expect((await ctx.prisma.contact.findUniqueOrThrow({ where: { id: contact.id } })).consentStatus).toBe('OPTED_OUT');
    expect((await run(ok.body.id)).result).toBe('sent');
  });

  it('refuses the code past the per-phone limit with Retry-After, and an admin can change the limit', async () => {
    expect((await settings({ defaultTemplateId: template.id, defaultNumberId: number.id, limitPerPhone: 2, limitWindowMinutes: 15 })).status).toBe(200);
    const phone = uaePhone();
    expect((await sendCode(ctx, key, { to: phone, code: '111111' })).status).toBe(202);
    expect((await sendCode(ctx, key, { to: phone, code: '222222' })).status).toBe(202);
    const third = await sendCode(ctx, key, { to: phone, code: '333333' });
    expect(third.status).toBe(429);
    expect(third.body.code).toBe('TOO_MANY_CODES');
    expect(Number(third.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('answers a repeated idempotent request once, and refuses a changed body', async () => {
    const phone = uaePhone();
    const idem = uniq('otp-idem-');
    const first = await sendCode(ctx, key, { to: phone, code: '654321' }, idem);
    const again = await sendCode(ctx, key, { to: phone, code: '654321' }, idem);
    expect(again.status).toBe(202);
    expect(again.body.id).toBe(first.body.id);
    expect(await ctx.prisma.message.count({ where: { origin: 'OTP', phoneE164: phone } })).toBe(1);
    expect((await sendCode(ctx, key, { to: phone, code: '000000' }, idem)).status).toBe(409);
    const stored = await ctx.prisma.idempotencyRecord.findMany({ where: { key: idem } });
    expect(JSON.stringify(stored)).not.toContain('654321');
  });

  it('reports statuses to the caller and to otp.status events, without the code', async () => {
    const phone = uaePhone();
    const res = await sendCode(ctx, key, { to: phone, code: '777777' });
    await run(res.body.id);
    const sent = fake.sentTo(phone).at(-1)!;
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.status(number.phoneNumberId, sent.wamid, phone.slice(1), 'delivered')));
    const status = await codeStatus(ctx, key, res.body.id);
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ id: res.body.id, to: phone, status: 'delivered', deliveredAt: expect.any(String) });
    const events = await ctx.prisma.outboundEvent.findMany({ where: { type: 'otp.status' }, orderBy: { createdAt: 'desc' }, take: 5 });
    expect(events.some((e) => (e.data as { otp?: { id?: string; status?: string } }).otp?.id === res.body.id)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('777777');

    const otherKey = await apiKeyWithScopes(ctx, admin, ['otp.send']);
    expect((await codeStatus(ctx, otherKey, res.body.id)).status).toBe(404);
  });

  it('fails at once when the number is stopped', async () => {
    await ctx.prisma.whatsAppNumber.update({ where: { id: number.id }, data: { sendingEnabled: false } });
    try {
      const res = await sendCode(ctx, key, { to: uaePhone(), code: '123456' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('NUMBER_NOT_SENDING');
    } finally {
      await ctx.prisma.whatsAppNumber.update({ where: { id: number.id }, data: { sendingEnabled: true } });
    }
  });
});
