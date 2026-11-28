import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { AudienceUploadProcessor } from '../../src/modules/campaigns/audience-upload.processor.js';
import { CampaignsService } from '../../src/modules/campaigns/campaigns.service.js';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { TemplatesSyncService } from '../../src/modules/templates/templates-sync.service.js';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { csvFile, digits, restoreNetwork, seedContact, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T041 (feature 009 US3, research R7, contracts/meta-templates.md): limited-time offers with an end time and
// each recipient's own code (from a contact attribute or an upload column); nothing is sent after the end.

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const HOUR = 3_600_000;

describe('Limited-time offer templates (009 US3)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let fake: FakeTemplatesGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let templateId: string;
  let tagName: string;
  const phones = { coded: uaePhone(), other: uaePhone(), missing: uaePhone() };

  const api = (method: 'post' | 'put', url: string, body: object = {}) => manager.agent[method](`/api${url}`).set('x-csrf-token', manager.csrf).send(body);
  const dispatchAndSend = async (campaignId: string) => {
    const dispatcher = ctx.app.get(DispatcherProcessor);
    const sender = ctx.app.get(SendProcessor);
    const queue = ctx.app.get(QueueRegistry).sendQueue(number.id);
    for (let guard = 0; guard < 20; guard++) {
      await queue.drain();
      const tick = await dispatcher.tick(campaignId);
      if (tick.action !== 'claim' || tick.claimed === 0) return;
      const queued = await ctx.prisma.message.findMany({ where: { campaignId, status: 'QUEUED' } });
      for (const m of queued) await sender.process(m.id, 1);
    }
  };
  const sample = async () => {
    const res = await manager.agent.post('/api/media').set('x-csrf-token', manager.csrf).field('purpose', 'TEMPLATE_SAMPLE').attach('file', PNG, { filename: 'offer.png', contentType: 'image/png' });
    expect(res.status).toBe(201);
    return res.body.id as string;
  };
  /** A draft offer campaign to the tagged contacts, codes from their `offer_code` attribute. */
  const campaign = async (endsAt: Date) => {
    const res = await api('post', '/campaigns', {
      name: `Offer ${digits(5)}`,
      numberId: number.id,
      templateId,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag: tagName }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' }, 'BUTTON.1.1': { source: 'static', value: 'wknd' } },
      headerMediaAssetId: await sample(),
      offerConfig: { endsAt: endsAt.toISOString(), code: { source: 'attribute', key: 'offer_code' } },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  const offerParts = (phone: string) => fake.sentTo(phone).at(-1)!.body.template.components as Array<Record<string, unknown>>;
  const couponOf = (code: string) => ({ type: 'button', sub_type: 'copy_code', index: 0, parameters: [{ type: 'coupon_code', coupon_code: code }] });

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    fake = new FakeTemplatesGraph().install();
    const created = await api('post', '/templates', {
      wabaId: number.wabaId,
      name: `weekend_offer_${digits(6)}`,
      language: 'en_US',
      category: 'MARKETING',
      kind: 'LIMITED_TIME_OFFER',
      header: { format: 'IMAGE', mediaAssetId: await sample() },
      body: { text: 'Hi {{1}}, 20% off until Sunday.', examples: ['Sara'] },
      buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/offer/{{1}}', urlExample: 'wknd' }],
      offer: { offerText: 'Weekend deal', showsEndTime: true, codeExample: 'WKND20' },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    templateId = created.body.id as string;
    // Sync brings Meta's approval back.
    await ctx.app.get(TemplatesSyncService).syncWaba(number.wabaId);
    tagName = `offer-${digits(5)}`;
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    for (const [phone, code] of [[phones.coded, 'SARA20'], [phones.other, 'OMAR15'], [phones.missing, undefined]] as const) {
      const contact = await seedContact(ctx, phone, { name: 'Sara', consentStatus: 'OPTED_IN', attributes: code ? { offer_code: code } : {} });
      await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
    }
  });
  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await ctx.close();
  });

  it('submits the offer with no footer and the copy-code button first, and syncs it back', async () => {
    const body = fake.creates.at(-1)!;
    expect((body.components as Array<{ type: string }>).map((c) => c.type)).toEqual(['HEADER', 'LIMITED_TIME_OFFER', 'BODY', 'BUTTONS']);
    const buttons = (body.components as Array<{ type: string; buttons?: Array<{ type: string; example?: string }> }>).at(-1)!.buttons!;
    expect(buttons[0]).toEqual({ type: 'COPY_CODE', example: 'WKND20' });
    expect(await ctx.prisma.template.findUniqueOrThrow({ where: { id: templateId } })).toMatchObject({ kind: 'LIMITED_TIME_OFFER', status: 'APPROVED' });
  });

  it('sends each recipient their own code from an attribute and the end time, and skips recipients without a code', async () => {
    const endsAt = new Date(Date.now() + 48 * HOUR);
    const id = await campaign(endsAt);
    expect((await api('post', `/campaigns/${id}/launch`)).status).toBe(200);
    const skipped = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: id, phoneE164: phones.missing } });
    expect(skipped).toMatchObject({ status: 'SKIPPED', skipReason: 'OFFER_CODE_MISSING' });
    await dispatchAndSend(id);
    for (const [phone, code] of [[phones.coded, 'SARA20'], [phones.other, 'OMAR15']] as const) {
      expect(offerParts(phone)).toContainEqual({ type: 'limited_time_offer', parameters: [{ type: 'limited_time_offer', limited_time_offer: { expiration_time_ms: endsAt.getTime() } }] });
      expect(offerParts(phone)).toContainEqual(couponOf(code));
    }
  });

  it('takes codes from an upload column', async () => {
    const draft = await api('post', '/campaigns', {
      name: `Offer upload ${digits(5)}`,
      numberId: number.id,
      templateId,
      audienceType: 'UPLOAD',
      variableMapping: { 'BODY.1': { source: 'column', key: 'name' }, 'BUTTON.1.1': { source: 'static', value: 'wknd' } },
      headerMediaAssetId: await sample(),
      offerConfig: { endsAt: new Date(Date.now() + 48 * HOUR).toISOString(), code: { source: 'column', key: 'code' } },
    });
    expect(draft.status, JSON.stringify(draft.body)).toBe(201);
    const rows = { first: uaePhone(), second: uaePhone(), blank: uaePhone() };
    const uploaded = await manager.agent
      .post(`/api/campaigns/${draft.body.id}/audience-upload`)
      .set('x-csrf-token', manager.csrf)
      .field('phoneColumn', 'phone')
      .field('optInConfirmed', 'true')
      .field('optInSourceNote', 'Signed up for offers at the store')
      .attach('file', csvFile(['name,phone,code', `Amna,${rows.first},AMNA10`, `Bilal,${rows.second},BILAL25`, `Chen,${rows.blank},`]), { filename: 'offer.csv', contentType: 'text/csv' });
    expect(uploaded.status, JSON.stringify(uploaded.body)).toBe(202);
    await ctx.app.get(AudienceUploadProcessor).process(uploaded.body.id);

    expect((await api('post', `/campaigns/${draft.body.id}/launch`)).status).toBe(200);
    expect(await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: draft.body.id, phoneE164: rows.blank } })).toMatchObject({ status: 'SKIPPED', skipReason: 'OFFER_CODE_MISSING' });
    await dispatchAndSend(draft.body.id);
    expect(offerParts(rows.first)).toContainEqual(couponOf('AMNA10'));
    expect(offerParts(rows.second)).toContainEqual(couponOf('BILAL25'));
  });

  it('refuses an offer that has ended or ends before the scheduled start', async () => {
    const ended = await campaign(new Date(Date.now() - 60_000));
    const refused = await api('post', `/campaigns/${ended}/launch`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('OFFER_ENDED');

    const early = await campaign(new Date(Date.now() + HOUR));
    const scheduled = await api('post', `/campaigns/${early}/launch`, { scheduledAt: new Date(Date.now() + 2 * HOUR).toISOString() });
    expect(scheduled.status).toBe(422);
    expect(scheduled.body.code).toBe('OFFER_ENDS_BEFORE_START');
  });

  it('drops the messages still waiting once the offer has ended, counted in the results', async () => {
    const id = await campaign(new Date(Date.now() + HOUR));
    expect((await api('post', `/campaigns/${id}/launch`)).status).toBe(200);
    // As if the campaign was paused until after the end: the messages still waiting are not sent.
    const pending = await ctx.prisma.message.findMany({ where: { campaignId: id, status: 'PENDING' } });
    expect(pending).toHaveLength(2);
    for (const m of pending) {
      await ctx.prisma.message.update({ where: { id: m.id }, data: { resolvedParams: { ...(m.resolvedParams as Record<string, string>), $offerEndsAt: String(Date.now() - 1_000) } } });
    }
    const sentBefore = fake.sends.length;
    await dispatchAndSend(id);
    expect(fake.sends.length).toBe(sentBefore);
    const expired = await ctx.prisma.message.findMany({ where: { campaignId: id, status: 'EXPIRED' } });
    expect(expired).toHaveLength(2);
    expect(expired.every((m) => m.expiredReason === 'OFFER_ENDED')).toBe(true);
    expect((await ctx.app.get(CampaignsService).computeTotals(id)).expired).toBe(2);
    const report = await manager.agent.get(`/api/campaigns/${id}/report`);
    expect(report.status).toBe(200);
    expect(report.body.expired).toEqual({ expiredBeforeSending: 0, notDeliveredInTime: 0, offerEnded: 2 });
  });
});
