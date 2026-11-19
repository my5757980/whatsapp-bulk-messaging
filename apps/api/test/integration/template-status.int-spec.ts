import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { META_BASE, META_VERSION, digits, restoreNetwork, seedNumber, seedRunningCampaign, seedTemplate, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T134: message_template_status_update webhooks (FR-016, FR-019, FR-027).
describe('Template status webhooks', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let wabaId: string;
  let numberId: string;

  const deliver = async (template: { metaTemplateId: string | null; name: string; language: string }, event: string, reason?: string) =>
    ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.templateStatus(wabaId, template.metaTemplateId as string, template.name, template.language, event, reason)));
  const template = (id: string) => ctx.prisma.template.findUniqueOrThrow({ where: { id } });

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
    const number = await seedNumber(ctx);
    wabaId = number.wabaId;
    numberId = number.id;
  });
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('marks templates approved and stores rejection reasons', async () => {
    const pending = await seedTemplate(ctx, wabaId, { status: 'PENDING' });
    await deliver(pending, 'APPROVED');
    expect((await template(pending.id)).status).toBe('APPROVED');

    const other = await seedTemplate(ctx, wabaId, { status: 'PENDING' });
    await deliver(other, 'REJECTED', 'INVALID_FORMAT');
    expect(await template(other.id)).toMatchObject({ status: 'REJECTED', rejectionReason: 'INVALID_FORMAT' });

    await deliver(other, 'REINSTATED');
    expect(await template(other.id)).toMatchObject({ status: 'APPROVED', rejectionReason: null });
  });

  it('auto-pauses running campaigns when Meta pauses or disables their template', async () => {
    const paused = await seedTemplate(ctx, wabaId);
    const disabled = await seedTemplate(ctx, wabaId);
    const untouched = await seedTemplate(ctx, wabaId);
    const c1 = await seedRunningCampaign(ctx, { numberId, templateId: paused.id, createdById: admin.userId, contacts: [] });
    const c2 = await seedRunningCampaign(ctx, { numberId, templateId: disabled.id, createdById: admin.userId, contacts: [] });
    const c3 = await seedRunningCampaign(ctx, { numberId, templateId: untouched.id, createdById: admin.userId, contacts: [] });

    await deliver(paused, 'PAUSED');
    await deliver(paused, 'PAUSED'); // re-delivery is harmless
    await deliver(disabled, 'DISABLED');

    expect((await template(paused.id)).status).toBe('PAUSED');
    expect((await template(disabled.id)).status).toBe('DISABLED');
    const campaigns = await ctx.prisma.campaign.findMany({ where: { id: { in: [c1.id, c2.id, c3.id] } } });
    const byId = Object.fromEntries(campaigns.map((c) => [c.id, c]));
    expect(byId[c1.id]).toMatchObject({ state: 'PAUSED', pausedReason: 'template_paused' });
    expect(byId[c2.id]).toMatchObject({ state: 'PAUSED', pausedReason: 'template_disabled' });
    expect(byId[c3.id]).toMatchObject({ state: 'RUNNING' });
    expect(await ctx.prisma.notification.count({ where: { userId: admin.userId, type: 'CAMPAIGN_AUTO_PAUSED', link: `/campaigns/${c1.id}` } })).toBe(1);
  });

  it('ignores flagged events and unknown templates', async () => {
    const approved = await seedTemplate(ctx, wabaId);
    await deliver(approved, 'FLAGGED');
    expect((await template(approved.id)).status).toBe('APPROVED');
    // An unknown template triggers a sync of its account (FR-016).
    const sync = nock(META_BASE).get(`/${META_VERSION}/${wabaId}/message_templates`).query(true).reply(200, { data: [] });
    await expect(deliver({ metaTemplateId: `unknown-${digits(6)}`, name: 'not_ours', language: 'en_US' }, 'APPROVED')).resolves.toBeUndefined();
    expect(sync.isDone()).toBe(true);
  });
});
