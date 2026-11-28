import { GENERAL_ADVICE, META_ERROR_MEANINGS } from '@wbm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MetricsService } from '../../src/common/metrics/metrics.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { digits, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T074 (feature 009 US7, research R12): failure reasons carry their meaning and action in campaign results
// and message details; an unknown code shows Meta's text with general advice and is counted; held back
// messages are counted.
describe('Help next to failure reasons (009 US7)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let campaignId: string;
  let sentId: string;
  let sentWamid: string;
  let sentPhone: string;

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' });
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: manager.userId, contacts: [] });
    campaignId = campaign.id;
    const rows = [
      { status: 'FAILED', failureCode: 131026, failureReason: 'Message undeliverable' },
      { status: 'FAILED', failureCode: 131049, failureReason: 'Held back by the per-person limit' },
      { status: 'EXPIRED', expiredReason: 'NOT_DELIVERED_IN_TIME' },
      { status: 'SENT', waMessageId: `wamid.help.${digits(10)}` },
    ] as const;
    for (const row of rows) {
      const contact = await seedContact(ctx, uaePhone());
      const message = await ctx.prisma.message.create({
        data: { origin: 'CAMPAIGN', campaignId, contactId: contact.id, phoneE164: contact.phoneE164, recipientCountry: 'AE', numberId: number.id, templateId: template.id, sentAt: new Date(), ...row },
      });
      if (row.status === 'SENT') {
        sentId = message.id;
        sentWamid = row.waMessageId;
        sentPhone = contact.phoneE164;
      }
    }
  });
  afterAll(async () => ctx.close());

  it('counts an unknown failure code and keeps Meta\'s text with general advice', async () => {
    const metrics = ctx.app.get(MetricsService);
    const before = (await metrics.unknownErrorCodes.get()).values.find((v) => v.labels.code === '139999')?.value ?? 0;
    await ctx.app.get(WebhooksProcessor).process(
      await postSignedWebhook(ctx, webhook.status(number.phoneNumberId, sentWamid, sentPhone.slice(1), 'failed', { errors: [{ code: 139999, title: 'A brand new problem' }] })),
    );
    expect(await ctx.prisma.message.findUniqueOrThrow({ where: { id: sentId } })).toMatchObject({ status: 'FAILED', failureCode: 139999 });
    const after = (await metrics.unknownErrorCodes.get()).values.find((v) => v.labels.code === '139999')?.value ?? 0;
    expect(after).toBe(before + 1);
  });

  it('shows the meaning and action of every reason in the results and the message details', async () => {
    const report = await manager.agent.get(`/api/campaigns/${campaignId}/report`);
    expect(report.status).toBe(200);
    const reasons = new Map((report.body.failureReasons as Array<{ code: number; meaning: string; action: string }>).map((r) => [r.code, r]));
    expect(reasons.get(131026)).toMatchObject({ meaning: META_ERROR_MEANINGS[131026]!.meaning, action: META_ERROR_MEANINGS[131026]!.action });
    expect(reasons.get(139999)).toMatchObject({ meaning: expect.stringContaining('A brand new problem'), action: GENERAL_ADVICE });
    expect(report.body.heldBack).toBe(1);

    const messages = await manager.agent.get(`/api/campaigns/${campaignId}/messages?pageSize=50`);
    const byStatus = (status: string) => (messages.body.items as Array<{ status: string; failureCode: number | null; failureHelp: { meaning: string; action: string } | null }>).filter((m) => m.status === status);
    expect(byStatus('FAILED').every((m) => m.failureHelp && m.failureHelp.meaning && m.failureHelp.action)).toBe(true);
    expect(byStatus('EXPIRED')[0]!.failureHelp).toMatchObject({ meaning: expect.stringContaining('could not deliver') });
    expect(byStatus('FAILED').find((m) => m.failureCode === 131049)!.failureHelp!.meaning).toBe(META_ERROR_MEANINGS[131049]!.meaning);
  });
});
