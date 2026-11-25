import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { AdLeadsProcessor } from '../../src/modules/ads/leads/ad-leads.processor.js';
import { OutboundEvents } from '../../src/modules/integrations/webhooks/outbound-events.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { ADS_PAGE_TOKEN, clearAds, seedAdsConnection } from '../support/ads.js';
import { FakeAdsGraph } from '../support/fake-ads-graph.js';
import { restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T055 (feature 007 US7, FR-035 – FR-039, research R9): lead forms made at Meta with the page token and
// a WhatsApp consent checkbox; page `leadgen` webhooks through the 001 receiver; each lead becomes a
// tagged contact, opted in (LEAD_FORM) only when the box was ticked, with the welcome template once;
// repeats recorded once; the catch-up; the leads list, the export and the outbound event; lead ads.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- tests read nested response and Graph bodies
type Json = Record<string, any>;

describe('Lead forms and leads (007 US7)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  let graph: FakeAdsGraph;
  let tagId: string;
  let templateId: string;
  let numberId: string;
  let form: Json;
  const phones = { consenting: uaePhone(), silent: uaePhone(), optedOut: uaePhone() };

  const send = (who: SignedInAgent, method: 'post' | 'patch', url: string, body?: object) => who.agent[method](`/api${url}`).set('X-CSRF-Token', who.csrf).send(body ?? {});
  const input = (overrides: Json = {}) => ({
    name: uniq('Spring offer '),
    questions: { standard: ['FULL_NAME', 'PHONE'], custom: [{ key: 'city', label: 'Your city' }] },
    privacyUrl: 'https://example.com/privacy',
    consentText: 'Yes, send me offers on WhatsApp',
    tagId,
    welcomeTemplateId: templateId,
    welcomeMapping: { 'BODY.1': { source: 'column', key: 'full_name', fallback: 'there' } },
    ...overrides,
  });
  const lead = (id: string, phone: string | null, consent: boolean, extra: Json = {}) => {
    graph.leads.set(id, {
      id,
      created_time: new Date().toISOString().replace('Z', '+0000'),
      ad_id: 'AD_FROM_META',
      form_id: form.metaFormId,
      field_data: [{ name: 'full_name', values: [`Lead ${id}`] }, ...(phone ? [{ name: 'phone_number', values: [phone] }] : []), { name: 'city', values: ['Dubai'] }],
      custom_disclaimer_responses: [{ checkbox_key: 'whatsapp_consent', is_checked: consent ? '1' : '' }],
      ...extra,
    });
  };
  const webhookFor = async (leadgenId: string) => {
    const payload = { object: 'page', entry: [{ id: 'P1', time: Math.floor(Date.now() / 1000), changes: [{ field: 'leadgen', value: { leadgen_id: leadgenId, form_id: form.metaFormId, ad_id: 'AD_FROM_META', page_id: 'P1', created_time: Math.floor(Date.now() / 1000) } }] }] };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
  };
  const contactOf = (phone: string) => ctx.prisma.contact.findUnique({ where: { phoneE164: phone }, include: { tags: true } });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    await clearAds(ctx);
    await seedAdsConnection(ctx);
    manager = await signIn(ctx, 'MANAGER');
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
    graph = new FakeAdsGraph();
    graph.install();
    const number = await seedNumber(ctx);
    numberId = number.id;
    templateId = (await seedTemplate(ctx, number.wabaId)).id;
    tagId = (await ctx.prisma.tag.create({ data: { name: uniq('spring-') } })).id;
    const endpoint = await send(admin, 'post', '/webhook-endpoints', { name: uniq('Leads hook '), url: `https://leads-${randomUUID().slice(0, 6)}.example.test/hooks`, eventTypes: ['ad.lead_received'] });
    expect(endpoint.status, JSON.stringify(endpoint.body)).toBe(201);
    ctx.app.get(OutboundEvents).invalidate();
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearAds(ctx);
    await ctx.close();
  });

  it('makes the form at Meta with the page token and subscribes the page to leads; checks the consent text and the welcome template', async () => {
    const bad = await send(manager, 'post', '/ads/lead-forms', input({ consentText: 'Yes, send me offers by text' }));
    expect(bad.status).toBe(422);
    expect(bad.body.details).toContainEqual({ field: 'consentText', issue: 'must name WhatsApp, so people know what they agree to' });
    expect((await send(manager, 'post', '/ads/lead-forms', input({ questions: { standard: ['FULL_NAME', 'EMAIL'] } }))).status).toBe(422);
    const unmapped = await send(manager, 'post', '/ads/lead-forms', input({ welcomeMapping: {} }));
    expect(unmapped.body.details).toContainEqual({ field: 'welcomeMapping', issue: 'needs a value for BODY.1' });

    const res = await send(manager, 'post', '/ads/lead-forms', input());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    form = res.body;
    expect(form).toMatchObject({ leads: 0, tagId, welcomeTemplateId: templateId, metaFormId: expect.any(String) });
    const made = graph.leadForms.get(form.metaFormId)!;
    expect(made).toMatchObject({ pageId: 'P1', token: `Bearer ${ADS_PAGE_TOKEN}` });
    expect(JSON.parse(made.questions)).toEqual([{ type: 'FULL_NAME' }, { type: 'PHONE' }, { type: 'CUSTOM', key: 'city', label: 'Your city' }]);
    expect(JSON.parse(made.legal_content).custom_disclaimer.checkboxes[0]).toMatchObject({ key: 'whatsapp_consent', text: 'Yes, send me offers on WhatsApp', is_checked_by_default: false });
    expect(graph.subscriptions.at(-1)).toMatchObject({ pageId: 'P1', body: { subscribed_fields: 'leadgen' }, token: `Bearer ${ADS_PAGE_TOKEN}` });
    expect((await send(manager, 'post', '/ads/lead-forms', input({ name: form.name }))).body.code).toBe('NAME_TAKEN');
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ad_lead_form.created', targetId: form.id } })).toBe(1);
  });

  it('turns a leadgen webhook into a tagged contact, opted in only when the box was ticked, with the welcome template once', async () => {
    lead('L1', phones.consenting, true);
    lead('L2', phones.silent, false);
    await webhookFor('L1');
    await webhookFor('L2');
    const l1 = await ctx.prisma.adLead.findUniqueOrThrow({ where: { metaLeadId: 'L1' } });
    expect(l1).toMatchObject({ status: 'PROCESSED', consent: true, phoneE164: phones.consenting, formId: form.id });
    const consenting = (await contactOf(phones.consenting))!;
    expect(consenting).toMatchObject({ consentStatus: 'OPTED_IN', consentSource: 'LEAD_FORM', name: 'Lead L1' });
    expect(consenting.tags.map((t) => t.tagId)).toContain(tagId);
    const welcome = await ctx.prisma.message.findMany({ where: { adLeadId: l1.id } });
    expect(welcome).toEqual([expect.objectContaining({ origin: 'ADS', templateId, numberId, contactId: consenting.id, status: 'QUEUED', resolvedParams: { 'BODY.1': 'Lead L1' } })]);

    const silent = (await contactOf(phones.silent))!;
    expect(silent.consentStatus).toBe('UNKNOWN');
    expect(silent.tags.map((t) => t.tagId)).toContain(tagId);
    const l2 = await ctx.prisma.adLead.findUniqueOrThrow({ where: { metaLeadId: 'L2' } });
    expect(await ctx.prisma.message.count({ where: { adLeadId: l2.id } })).toBe(0);

    // A repeated webhook records nothing new and sends nothing again.
    await webhookFor('L1');
    expect(await ctx.prisma.adLead.count({ where: { metaLeadId: 'L1' } })).toBe(1);
    expect(await ctx.prisma.message.count({ where: { adLeadId: l1.id } })).toBe(1);

    // An opted-out contact who does not tick the box stays opted out and gets no welcome.
    await seedContact(ctx, phones.optedOut, { consentStatus: 'OPTED_OUT' });
    lead('L3', phones.optedOut, false);
    await webhookFor('L3');
    expect((await contactOf(phones.optedOut))!.consentStatus).toBe('OPTED_OUT');
    const l3 = await ctx.prisma.adLead.findUniqueOrThrow({ where: { metaLeadId: 'L3' } });
    expect(await ctx.prisma.message.count({ where: { adLeadId: l3.id } })).toBe(0);

    const event = await ctx.prisma.outboundEvent.findFirst({ where: { type: 'ad.lead_received' }, orderBy: { createdAt: 'desc' } });
    expect(event?.data).toMatchObject({ leadForm: { id: form.id, name: form.name }, metaLeadId: 'L3', consent: false, status: 'PROCESSED' });
    expect(JSON.stringify(event?.data)).not.toContain('Dubai');
  });

  it('finds missed leads in the catch-up, with no phone and invalid phone statuses', async () => {
    lead('L4', null, true);
    lead('L5', 'not a phone', true);
    expect(await ctx.app.get(AdLeadsProcessor).catchUp()).toBe(2);
    expect(await ctx.prisma.adLead.findUniqueOrThrow({ where: { metaLeadId: 'L4' } })).toMatchObject({ status: 'NO_PHONE', contactId: null });
    expect(await ctx.prisma.adLead.findUniqueOrThrow({ where: { metaLeadId: 'L5' } })).toMatchObject({ status: 'INVALID_PHONE', contactId: null });
    expect(await ctx.app.get(AdLeadsProcessor).catchUp()).toBe(0);
    expect((await manager.agent.get(`/api/ads/lead-forms/${form.id}`)).body.leads).toBe(5);
  });

  it('lists the leads with phones masked for agents, and exports them with an audit entry', async () => {
    const full = await manager.agent.get(`/api/ads/lead-forms/${form.id}/leads?pageSize=10`);
    expect(full.status).toBe(200);
    expect(full.body.total).toBe(5);
    const first = (full.body.items as Json[]).find((l) => l.phone === phones.consenting)!;
    expect(first).toMatchObject({ consent: true, status: 'PROCESSED', answers: { full_name: 'Lead L1', city: 'Dubai' } });
    expect(first.answers.phone_number).toBeUndefined();
    const masked = await agent.agent.get(`/api/ads/lead-forms/${form.id}/leads?pageSize=10`);
    expect((masked.body.items as Json[]).every((l) => !Object.values(phones).includes(l.phone))).toBe(true);

    const csv = await manager.agent.get(`/api/ads/lead-forms/${form.id}/leads/export`);
    expect(csv.status).toBe(200);
    expect(csv.text.split('\n')[0]).toBe('submitted_at,name,phone,email,consent,status,answers');
    expect(csv.text).toContain(phones.consenting);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'ad_leads.exported', targetId: form.id } })).toBe(1);
    expect((await agent.agent.get(`/api/ads/lead-forms/${form.id}/leads/export`)).status).toBe(403);
  });

  it('changes the tag and welcome template, and launches a lead ad that uses the form', async () => {
    const changed = await send(manager, 'patch', `/ads/lead-forms/${form.id}`, { welcomeTemplateId: null });
    expect(changed.status).toBe(200);
    expect(changed.body.welcomeTemplateId).toBeNull();

    const key = `library/lead-${randomUUID()}.jpg`;
    await ctx.app.get(StorageService).put(key, Buffer.from('jpeg-bytes'), 'image/jpeg');
    const media = await ctx.prisma.mediaAsset.create({ data: { storageKey: key, mimeType: 'image/jpeg', sizeBytes: 100_000, purpose: 'LIBRARY' } });
    const created = await send(manager, 'post', '/ads/campaigns', {
      name: uniq('Lead ad '),
      goal: 'LEADS',
      leadFormId: form.id,
      targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country', countryCode: 'AE' }] },
      placements: { auto: true },
      dailyBudgetMinor: 5_000,
      startAt: new Date().toISOString(),
      versions: [{ mediaAssetId: media.id, primaryText: 'Get the spring offer', headline: 'Sign up', callToAction: 'SIGN_UP' }],
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await send(manager, 'post', `/ads/campaigns/${created.body.id}/submit`)).status).toBe(200);
    const row = await ctx.prisma.adCampaign.findUniqueOrThrow({ where: { id: created.body.id }, include: { versions: true } });
    expect(graph.campaigns.get(row.metaCampaignId!)).toMatchObject({ objective: 'OUTCOME_LEADS' });
    expect(graph.adsets.get(row.metaAdsetId!)).toMatchObject({ destination_type: 'ON_AD', optimization_goal: 'LEAD_GENERATION', promoted_object: { page_id: 'P1' } });
    expect(graph.creatives.get(row.versions[0]!.metaCreativeId!)!.object_story_spec.link_data.call_to_action).toEqual({ type: 'SIGN_UP', value: { lead_gen_form_id: form.metaFormId, link: 'http://fb.me/' } });
  });
});
