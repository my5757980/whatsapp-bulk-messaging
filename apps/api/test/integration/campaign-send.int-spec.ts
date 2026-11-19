import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { AudienceUploadProcessor } from '../../src/modules/campaigns/audience-upload.processor.js';
import { CampaignProgressProcessor } from '../../src/modules/campaigns/campaign-progress.processor.js';
import { sendJobId } from '../../src/modules/sending/dispatch-planner.js';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { csvFile, mockMetaSends, restoreNetwork, seedNumber, seedTemplate, setDefaultCountry, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T078: send-now end to end - draft -> upload -> launch -> Meta (nock) -> signed status webhooks.
describe('Campaign send-now flow', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let phoneNumberId: string;
  let numberId: string;
  let campaignId: string;

  const recipients = ['+971502220001', '+971502220002', '+971502220003', '+971502220000'];

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    const number = await seedNumber(ctx, { sendRatePerSecond: 20 });
    phoneNumberId = number.phoneNumberId;
    numberId = number.id;
    const template = await seedTemplate(ctx, number.wabaId, {
      name: 'order_update',
      components: [{ type: 'BODY', text: 'Hi {{1}}, your order has shipped.' }],
    });

    const draft = await admin.agent
      .post('/api/campaigns')
      .set('x-csrf-token', admin.csrf)
      .send({ name: 'Shipping notice', numberId, templateId: template.id, audienceType: 'UPLOAD' });
    campaignId = draft.body.id;
  });
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('uploads, maps variables and estimates', async () => {
    const res = await admin.agent
      .post(`/api/campaigns/${campaignId}/audience-upload`)
      .set('x-csrf-token', admin.csrf)
      .field('phoneColumn', 'phone')
      .field('nameColumn', 'name')
      .field('optInConfirmed', 'true')
      .field('optInSourceNote', 'Order checkout consent')
      .attach('file', csvFile(['name,phone', ...recipients.map((p, i) => `Customer ${i + 1},${p}`)]), { filename: 'list.csv', contentType: 'text/csv' });
    expect(res.status).toBe(202);
    await ctx.app.get(AudienceUploadProcessor).process(res.body.id);

    const mapped = await admin.agent
      .patch(`/api/campaigns/${campaignId}`)
      .set('x-csrf-token', admin.csrf)
      .send({ variableMapping: { 'BODY.1': { source: 'column', key: 'name', fallback: 'there' } } });
    expect(mapped.status).toBe(200);

    const estimate = await admin.agent.post(`/api/campaigns/${campaignId}/estimate`).set('x-csrf-token', admin.csrf);
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({
      eligible: 4,
      excluded: { optedOut: 0, noOptIn: 0, invalidNumber: 0, duplicate: 0, missingVariable: 0 },
    });
    expect(estimate.body.previews).toHaveLength(3);
    expect(estimate.body.previews[0]).toEqual({ phoneMasked: '•••• 0001', text: 'Hi Customer 1, your order has shipped.' });
  });

  it('launches, dispatches and sends exactly one message per recipient', async () => {
    const launched = await admin.agent.post(`/api/campaigns/${campaignId}/launch`).set('x-csrf-token', admin.csrf).send({});
    expect(launched.status).toBe(200);
    expect(launched.body.state).toBe('RUNNING');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'campaign.launched', targetId: campaignId } })).toBe(1);
    expect(await ctx.prisma.message.count({ where: { campaignId, status: 'PENDING' } })).toBe(4);

    const tick = await ctx.app.get(DispatcherProcessor).tick(campaignId);
    expect(tick).toMatchObject({ action: 'claim', claimed: 4 });
    const queued = await ctx.prisma.message.findMany({ where: { campaignId, status: 'QUEUED' } });
    expect(queued).toHaveLength(4);
    const queue = ctx.app.get(QueueRegistry).sendQueue(numberId);
    expect(await queue.getJob(sendJobId(queued[0]!.id))).toBeTruthy();

    const calls = mockMetaSends(phoneNumberId, recipients);
    const sender = ctx.app.get(SendProcessor);
    const outcomes = [];
    for (const message of queued) outcomes.push(await sender.process(message.id, 1));
    expect(outcomes.filter((o) => o.result === 'sent')).toHaveLength(3);
    expect(outcomes.filter((o) => o.result === 'failed')).toHaveLength(1);
    expect(calls.map((c) => c.to).sort()).toEqual(recipients.map((p) => p.slice(1)).sort());
    expect(calls[0]?.body).toMatchObject({ type: 'template', template: { name: 'order_update', language: { code: 'en_US' } } });

    // A re-delivered job for an already-sent message never calls Meta again.
    expect(await sender.process(queued[0]!.id, 1)).toEqual({ result: 'ignored' });
    expect(nock.pendingMocks()).toHaveLength(0);

    const failed = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId, phoneE164: '+971502220000' } });
    expect(failed).toMatchObject({ status: 'FAILED', failureCode: 131026 });
    expect(failed.failureReason).toMatch(/undeliverable/i);
  });

  it('applies signed status webhooks with precedence and dedupe, then completes', async () => {
    const processor = ctx.app.get(WebhooksProcessor);
    const deliver = async (phone: string, status: string) =>
      processor.process(await postSignedWebhook(ctx, webhook.status(phoneNumberId, `wamid.${phone.slice(1)}`, phone.slice(1), status)));

    await deliver(recipients[0]!, 'read'); // read before delivered (out of order)
    await deliver(recipients[0]!, 'delivered');
    await deliver(recipients[1]!, 'delivered');
    await deliver(recipients[1]!, 'delivered'); // duplicate
    await deliver(recipients[1]!, 'read');
    await deliver(recipients[2]!, 'delivered');

    const first = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId, phoneE164: recipients[0] } });
    expect(first.status).toBe('READ');
    expect(first.deliveredAt).toBeTruthy();
    expect(first.readAt).toBeTruthy();
    const second = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId, phoneE164: recipients[1] }, include: { events: true } });
    expect(second.events.filter((e) => e.type === 'DELIVERED')).toHaveLength(1);

    await ctx.app.get(CampaignProgressProcessor).refresh();

    const campaign = await admin.agent.get(`/api/campaigns/${campaignId}`);
    expect(campaign.body.state).toBe('COMPLETED');
    expect(campaign.body.totals).toEqual({ pending: 0, queued: 0, sent: 0, delivered: 1, read: 2, failed: 1, skipped: 0, cancelled: 0 });
    expect(await ctx.prisma.notification.count({ where: { userId: admin.userId, type: 'CAMPAIGN_COMPLETED', link: `/campaigns/${campaignId}` } })).toBe(1);

    const messages = await admin.agent.get(`/api/campaigns/${campaignId}/messages`).query({ status: 'FAILED' });
    expect(messages.status).toBe(200);
    expect(messages.body.page).toEqual({ page: 1, pageSize: 50, total: 1 });
    expect(messages.body.items[0]).toMatchObject({ phone: '+971502220000', status: 'FAILED', failureCode: 131026, contactName: 'Customer 4' });
  });

  it('masks recipient phones for agents', async () => {
    const agent = await signIn(ctx, 'AGENT');
    const res = await agent.agent.get(`/api/campaigns/${campaignId}/messages`);
    expect(res.status).toBe(200);
    expect(res.body.items.every((m: { phone: string }) => m.phone.startsWith('••••'))).toBe(true);
  });
});
