import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T035 (feature 006 US3, FR-017 - FR-022, research R6): API campaigns from building to results.
describe('API campaigns (006 US3)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let key: string;
  let keyId: string;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let utility: Awaited<ReturnType<typeof seedTemplate>>;
  const values = { order: 'A-1001', product: 'Shoes' };

  const dashboard = (method: 'get' | 'post' | 'patch' | 'put', url: string, body?: object) =>
    method === 'get' ? admin.agent.get(`/api${url}`) : admin.agent[method](`/api${url}`).set('X-CSRF-Token', admin.csrf).send(body ?? {});
  const trigger = (apiName: string, body: object, idempotencyKey?: string, secret = key) => {
    const req = request(ctx.server()).post(`/api/v1/api-campaigns/${apiName}/messages`).set('Authorization', `Bearer ${secret}`);
    return (idempotencyKey ? req.set('Idempotency-Key', idempotencyKey) : req).send(body);
  };
  const twoValueTemplate = (wabaId: string, category: 'UTILITY' | 'MARKETING' = 'UTILITY') =>
    seedTemplate(ctx, wabaId, {
      category,
      components: [{ type: 'BODY', text: 'Order {{1}}: how did you like {{2}}?' }],
      variables: [
        { key: 'BODY.1', example: 'A-1001' },
        { key: 'BODY.2', example: 'Shoes' },
      ],
    });
  /** A live campaign mapping BODY.1 to the call value "order" and BODY.2 to "product", tagging "feedback". */
  const liveCampaign = async (overrides: Record<string, unknown> = {}) => {
    const created = await dashboard('post', '/api-campaigns', {
      name: uniq('Order feedback '),
      apiName: uniq('order-feedback-'),
      numberId: number.id,
      templateId: utility.id,
      variableMapping: { 'BODY.1': { source: 'value', key: 'order' }, 'BODY.2': { source: 'value', key: 'product' } },
      tags: ['feedback'],
      ...overrides,
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const live = await dashboard('post', `/api-campaigns/${created.body.id}/go-live`);
    expect(live.status, JSON.stringify(live.body)).toBe(200);
    return live.body as { id: string; apiName: string; name: string };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    admin = await signIn(ctx, 'ADMIN');
    number = await seedNumber(ctx);
    utility = await twoValueTemplate(number.wabaId);
    await ctx.prisma.attributeDefinition.upsert({ where: { key: 'last_product' }, create: { key: 'last_product', label: 'Last product', type: 'TEXT' }, update: {} });
    const created = await dashboard('post', '/api-keys', { name: uniq('Shop '), rateLimitPerMinute: 600 });
    key = created.body.secret;
    keyId = created.body.id;
    expect((await dashboard('put', `/api-keys/${keyId}/scopes`, { scopes: ['campaigns.trigger'] })).status).toBe(200);
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('goes live only when every variable has a source, and keeps the API name after that', async () => {
    const apiName = uniq('feedback-');
    const draft = await dashboard('post', '/api-campaigns', {
      name: uniq('Draft '),
      apiName,
      numberId: number.id,
      templateId: utility.id,
      variableMapping: { 'BODY.1': { source: 'value', key: 'order' } },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    expect(draft.body).toMatchObject({ status: 'DRAFT', apiName, createContacts: true, tags: [], dailyLimit: null, pausedReason: null });
    const refused = await dashboard('post', `/api-campaigns/${draft.body.id}/go-live`);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NOT_READY');
    expect(refused.body.problems).toEqual([expect.objectContaining({ message: expect.stringContaining('BODY.2') })]);

    const sameName = await dashboard('post', '/api-campaigns', { name: draft.body.name, apiName: uniq('other-'), numberId: number.id, templateId: utility.id });
    expect(sameName.status).toBe(409);
    expect(sameName.body.code).toBe('NAME_TAKEN');
    const sameApiName = await dashboard('post', '/api-campaigns', { name: uniq('Other '), apiName, numberId: number.id, templateId: utility.id });
    expect(sameApiName.body.code).toBe('API_NAME_TAKEN');
    expect((await dashboard('post', '/api-campaigns', { name: uniq('Bad '), apiName: 'Bad Name', numberId: number.id, templateId: utility.id })).status).toBe(422);
    expect((await dashboard('post', '/api-campaigns', { name: uniq('Bad '), apiName: uniq('attr-'), numberId: number.id, templateId: utility.id, attributes: { no_such_attribute: 'x' } })).status).toBe(422);

    const fixed = await dashboard('patch', `/api-campaigns/${draft.body.id}`, {
      variableMapping: { 'BODY.1': { source: 'value', key: 'order' }, 'BODY.2': { source: 'static', value: 'your order' } },
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
    const live = await dashboard('post', `/api-campaigns/${draft.body.id}/go-live`);
    expect(live.body).toMatchObject({ status: 'LIVE', pausedReason: null, todayTriggers: 0 });
    expect(live.body.callExample).toContain(`/api/v1/api-campaigns/${apiName}/messages`);
    expect(live.body.callExample).toContain('"order"');
    expect((await dashboard('get', `/api-campaigns/${draft.body.id}`)).body.templateName).toBe(utility.name);
    expect((await dashboard('get', '/api-campaigns?status=LIVE')).body.map((c: { id: string }) => c.id)).toContain(draft.body.id);

    const renamed = await dashboard('patch', `/api-campaigns/${draft.body.id}`, { apiName: uniq('renamed-') });
    expect(renamed.status).toBe(409);
    expect(renamed.body.code).toBe('API_NAME_FIXED');
    expect(await ctx.prisma.auditLog.count({ where: { targetId: draft.body.id, action: { in: ['api_campaign.created', 'api_campaign.updated', 'api_campaign.live'] } } })).toBe(3);

    // A key without the permission cannot trigger it.
    const sendOnly = (await dashboard('post', '/api-keys', { name: uniq('Send ') })).body.secret as string;
    const noScope = await trigger(apiName, { phone: uaePhone(), values }, undefined, sendOnly);
    expect(noScope.status).toBe(403);
    expect(noScope.body.code).toBe('insufficient_scope');
  });

  it('sends one message per trigger: a new phone becomes a tagged contact, and a repeat gets the first answer', async () => {
    const campaign = await liveCampaign({ attributes: { last_product: { fromValue: 'product' } } });
    const phone = uaePhone();
    const idem = uniq('order-');
    const first = await trigger(campaign.apiName, { phone, name: 'Layla', values }, idem);
    expect(first.status, JSON.stringify(first.body)).toBe(202);
    const contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone }, include: { tags: { include: { tag: true } } } });
    expect(first.body).toEqual({ messageId: expect.any(String), contactId: contact.id });
    expect(contact).toMatchObject({ name: 'Layla', attributes: { last_product: 'Shoes' } });
    expect(contact.tags.map((t) => t.tag.name)).toEqual(['feedback']);
    expect(await ctx.prisma.message.findUniqueOrThrow({ where: { id: first.body.messageId } })).toMatchObject({
      origin: 'API',
      apiCampaignId: campaign.id,
      apiKeyId: keyId,
      contactId: contact.id,
      numberId: number.id,
      templateId: utility.id,
      status: 'QUEUED',
      resolvedParams: { 'BODY.1': 'A-1001', 'BODY.2': 'Shoes' },
    });

    // An existing contact keeps their name; the call's name is for new contacts only.
    const existing = await seedContact(ctx, uaePhone(), { name: 'Omar' });
    const second = await trigger(campaign.apiName, { phone: existing.phoneE164, name: 'Someone else', values: { order: 'A-1002', product: 'Bag' } });
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    expect(await ctx.prisma.contact.findUniqueOrThrow({ where: { id: existing.id } })).toMatchObject({ name: 'Omar', attributes: { last_product: 'Bag' } });

    const repeat = await trigger(campaign.apiName, { phone, name: 'Layla', values }, idem);
    expect(repeat.status).toBe(202);
    expect(repeat.body).toEqual(first.body);
    expect(await ctx.prisma.message.count({ where: { apiCampaignId: campaign.id } })).toBe(2);
    expect(await ctx.prisma.apiCampaignTrigger.count({ where: { apiCampaignId: campaign.id, outcome: 'QUEUED', apiKeyId: keyId } })).toBe(2);
    expect((await dashboard('get', `/api-campaigns/${campaign.id}`)).body.todayTriggers).toBe(2);
  });

  it('refuses a call that misses a mapped value, naming it, and sends nothing', async () => {
    const campaign = await liveCampaign();
    const missing = await trigger(campaign.apiName, { phone: uaePhone(), values: { order: 'A-1003' } });
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: 'MISSING_VALUE', message: expect.stringContaining('product') });
    expect(await ctx.prisma.message.count({ where: { apiCampaignId: campaign.id } })).toBe(0);
    expect(await ctx.prisma.apiCampaignTrigger.findFirst({ where: { apiCampaignId: campaign.id } })).toMatchObject({ outcome: 'NOT_SENT', reason: 'missing_value' });
    const invalid = await trigger(campaign.apiName, { phone: '12', values });
    expect(invalid.status).toBe(422);
    expect(await ctx.prisma.apiCampaignTrigger.count({ where: { apiCampaignId: campaign.id, reason: 'invalid_phone' } })).toBe(1);
    expect((await trigger('no-such-campaign', { phone: uaePhone(), values })).status).toBe(404);
  });

  it('sends a marketing template only with an opt-in, which the call may record with a source note', async () => {
    const marketing = await twoValueTemplate(number.wabaId, 'MARKETING');
    const campaign = await liveCampaign({ templateId: marketing.id });
    const phone = uaePhone();
    const refused = await trigger(campaign.apiName, { phone, values });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'NOT_SENT', reason: 'no_opt_in' });
    expect(await ctx.prisma.contact.count({ where: { phoneE164: phone } })).toBe(0);
    const sent = await trigger(campaign.apiName, { phone, values, optIn: { sourceNote: 'Checkout checkbox' } });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } })).toMatchObject({ consentStatus: 'OPTED_IN', consentSource: 'API' });
  });

  it('records opted-out, blocked and unknown numbers as not sent', async () => {
    const campaign = await liveCampaign();
    const optedOut = await seedContact(ctx, uaePhone(), { consentStatus: 'OPTED_OUT' });
    const blocked = await seedContact(ctx, uaePhone(), { blockedAt: new Date() });
    expect((await trigger(campaign.apiName, { phone: optedOut.phoneE164, values, optIn: { sourceNote: 'again please' } })).body).toMatchObject({ code: 'NOT_SENT', reason: 'opted_out' });
    expect((await trigger(campaign.apiName, { phone: blocked.phoneE164, values })).body).toMatchObject({ code: 'NOT_SENT', reason: 'blocked' });
    const knownOnly = await liveCampaign({ createContacts: false });
    const unknown = uaePhone();
    const refused = await trigger(knownOnly.apiName, { phone: unknown, values });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: 'NOT_SENT', reason: 'not_a_contact' });
    expect(await ctx.prisma.contact.count({ where: { phoneE164: unknown } })).toBe(0);
    const reasons = (await ctx.prisma.apiCampaignTrigger.findMany({ where: { apiCampaignId: { in: [campaign.id, knownOnly.id] } } })).map((t) => t.reason).sort();
    expect(reasons).toEqual(['blocked', 'not_a_contact', 'opted_out']);
    expect(await ctx.prisma.message.count({ where: { apiCampaignId: { in: [campaign.id, knownOnly.id] } } })).toBe(0);
  });

  it('refuses calls while paused or stopped, and after the daily limit', async () => {
    const campaign = await liveCampaign({ dailyLimit: 1 });
    expect((await trigger(campaign.apiName, { phone: uaePhone(), values })).status).toBe(202);
    const limited = await trigger(campaign.apiName, { phone: uaePhone(), values });
    expect(limited.status).toBe(409);
    expect(limited.body.code).toBe('DAILY_LIMIT');

    expect((await dashboard('post', `/api-campaigns/${campaign.id}/pause`)).body).toMatchObject({ status: 'PAUSED', pausedReason: 'MEMBER' });
    expect((await dashboard('post', `/api-campaigns/${campaign.id}/pause`)).status).toBe(409);
    const paused = await trigger(campaign.apiName, { phone: uaePhone(), values });
    expect(paused.status).toBe(409);
    expect(paused.body).toMatchObject({ code: 'NOT_LIVE', reason: 'paused' });

    expect((await dashboard('post', `/api-campaigns/${campaign.id}/stop`)).body.status).toBe('STOPPED');
    expect((await trigger(campaign.apiName, { phone: uaePhone(), values })).body).toMatchObject({ code: 'NOT_LIVE', reason: 'stopped' });
    const changed = await dashboard('patch', `/api-campaigns/${campaign.id}`, { dailyLimit: 5 });
    expect(changed.status).toBe(409);
    expect(changed.body.code).toBe('STOPPED');
    expect((await dashboard('post', `/api-campaigns/${campaign.id}/go-live`)).status).toBe(409);
    // A stopped campaign frees its name.
    expect((await dashboard('post', '/api-campaigns', { name: campaign.name, apiName: uniq('again-'), numberId: number.id, templateId: utility.id })).status).toBe(201);

    const reasons = (await ctx.prisma.apiCampaignTrigger.findMany({ where: { apiCampaignId: campaign.id }, orderBy: { createdAt: 'asc' } })).map((t) => t.reason);
    expect(reasons).toEqual([null, 'daily_limit', 'not_live', 'not_live']);
    expect(await ctx.prisma.auditLog.count({ where: { targetId: campaign.id, action: { in: ['api_campaign.paused', 'api_campaign.stopped'] } } })).toBe(2);
  });

  it('pauses itself when its template stops being approved or its number disconnects, and alerts managers', async () => {
    const own = await seedNumber(ctx);
    const first = await twoValueTemplate(own.wabaId);
    const second = await twoValueTemplate(own.wabaId);
    const byTemplate = await liveCampaign({ numberId: own.id, templateId: first.id });
    const byNumber = await liveCampaign({ numberId: own.id, templateId: second.id });

    const change = webhook.templateStatus(own.wabaId, first.metaTemplateId as string, first.name, first.language, 'PAUSED');
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, change));
    expect(await ctx.prisma.apiCampaign.findUniqueOrThrow({ where: { id: byTemplate.id } })).toMatchObject({ status: 'PAUSED', pausedReason: 'TEMPLATE_UNAVAILABLE' });
    expect(await ctx.prisma.apiCampaign.findUniqueOrThrow({ where: { id: byNumber.id } })).toMatchObject({ status: 'LIVE' });
    expect(await ctx.prisma.notification.count({ where: { type: 'API_CAMPAIGN_PAUSED', link: `/campaigns/api/${byTemplate.id}`, userId: admin.userId } })).toBe(1);
    const refused = await trigger(byTemplate.apiName, { phone: uaePhone(), values });
    expect(refused.body).toMatchObject({ code: 'NOT_LIVE', reason: 'paused' });
    expect(refused.body.message).toMatch(/template/i);

    expect((await admin.agent.delete(`/api/numbers/${own.id}`).set('X-CSRF-Token', admin.csrf)).status).toBe(204);
    expect(await ctx.prisma.apiCampaign.findUniqueOrThrow({ where: { id: byNumber.id } })).toMatchObject({ status: 'PAUSED', pausedReason: 'NUMBER_DISCONNECTED' });
    expect(await ctx.prisma.notification.count({ where: { type: 'API_CAMPAIGN_PAUSED', link: `/campaigns/api/${byNumber.id}`, userId: admin.userId } })).toBe(1);
    expect((await dashboard('post', `/api-campaigns/${byNumber.id}/go-live`)).body.code).toBe('NOT_READY');
  });

  it('shows results in total and per day, exports them, and raises api_campaign.triggered events', async () => {
    const hook = await dashboard('post', '/webhook-endpoints', {
      name: uniq('Campaign events '),
      url: `https://${uniq('ac')}.example.test/hooks`,
      eventTypes: ['api_campaign.triggered'],
    });
    expect(hook.status, JSON.stringify(hook.body)).toBe(201);
    ctx.app.get(OutboundEvents).invalidate();
    const campaign = await liveCampaign();
    const read = await trigger(campaign.apiName, { phone: uaePhone(), values });
    const failed = await trigger(campaign.apiName, { phone: uaePhone(), values });
    expect((await trigger(campaign.apiName, { phone: uaePhone(), values: { order: 'A-1' } })).status).toBe(422);
    const now = new Date();
    await ctx.prisma.message.update({ where: { id: read.body.messageId }, data: { status: 'READ', sentAt: now, deliveredAt: now, readAt: now } });
    await ctx.prisma.message.update({ where: { id: failed.body.messageId }, data: { status: 'FAILED', failedAt: now, failureReason: 'Not a WhatsApp number' } });

    const results = await dashboard('get', `/api-campaigns/${campaign.id}/results`);
    expect(results.status).toBe(200);
    expect(results.body.totals).toEqual({ triggers: 3, sent: 1, delivered: 1, read: 1, failed: 1, clicked: 0, notSent: 1 });
    expect(results.body.days).toEqual([expect.objectContaining({ triggers: 3, sent: 1, delivered: 1, read: 1, failed: 1, notSent: 1, date: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) })]);
    expect(results.body.notSentReasons).toEqual({ missing_value: 1 });
    expect(results.body.failureReasons).toEqual({ 'Not a WhatsApp number': 1 });

    const csv = await dashboard('get', `/api-campaigns/${campaign.id}/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe('triggered_at,phone,outcome,reason,message_id,status,failure_reason');
    expect(lines).toHaveLength(4);
    expect(lines.some((l) => l.includes('Not a WhatsApp number'))).toBe(true);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'data.exported', targetId: campaign.id } })).toBe(1);

    const deliveries = await ctx.prisma.webhookDelivery.findMany({ where: { endpointId: hook.body.id }, include: { event: true } });
    const outcomes = deliveries.map((d) => d.event.data as { apiCampaign: { id: string }; outcome: string; reason: string | null });
    expect(outcomes.filter((o) => o.apiCampaign.id === campaign.id).map((o) => `${o.outcome}:${o.reason ?? ''}`).sort()).toEqual(['NOT_SENT:missing_value', 'QUEUED:', 'QUEUED:']);
  });
});
