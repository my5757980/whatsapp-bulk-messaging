import nock from 'nock';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { FakeTemplatesGraph } from '../support/fake-templates-graph.js';
import { digits, restoreNetwork, seedContact, seedNumber, seedTemplate, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T050 (feature 009 US4, research R9, contracts/templates-growth-api.openapi.yaml MediaCheck): the header
// media from a web address (one address, an upload column or a contact attribute), the launch check of
// every distinct address (sampled above 1,000, at most 50 problems shown), sends with `link`, and the
// public API's https-only rule.

const FILES = 'https://files.example.com';
const PDF = { 'content-type': 'application/pdf', 'content-length': '2048' };

describe('Campaign media from a web address (009 US4)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let admin: SignedInAgent;
  let fake: FakeTemplatesGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let templateId: string;
  let templateName: string;

  const api = (method: 'post' | 'put' | 'patch', url: string, body: object = {}) => manager.agent[method](`/api${url}`).set('x-csrf-token', manager.csrf).send(body);
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
  const mapping = (media: object) => ({ 'BODY.1': { source: 'field', key: 'name' }, 'HEADER.media': media });
  /** A draft to the tagged contacts. */
  const filterCampaign = async (tagName: string, media: object) => {
    const res = await api('post', '/campaigns', { name: `Invoices ${digits(5)}`, numberId: number.id, templateId, audienceType: 'FILTER', audienceFilter: { all: [{ tag: tagName }] }, variableMapping: mapping(media) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  };
  /** A draft with an uploaded audience whose rows are written directly (the check reads the rows). */
  const uploadCampaign = async (urls: string[]) => {
    const res = await api('post', '/campaigns', { name: `Invoices upload ${digits(5)}`, numberId: number.id, templateId, audienceType: 'UPLOAD', variableMapping: { 'BODY.1': { source: 'column', key: 'name' }, 'HEADER.media': { source: 'column', key: 'invoice_url' } } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const prefix = digits(3);
    await ctx.prisma.campaignUploadRow.createMany({
      data: urls.map((url, i) => ({ campaignId: res.body.id, rowNumber: i + 2, phoneE164: `+97152${prefix}${String(i).padStart(4, '0')}`, data: { name: `Row ${i + 2}`, phone: `+97152${prefix}${String(i).padStart(4, '0')}`, invoice_url: url } })),
    });
    return res.body.id as string;
  };
  const tagged = async (people: Array<{ name: string; attributes?: Record<string, string> }>) => {
    const tagName = `media-${digits(6)}`;
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    const phones: string[] = [];
    for (const p of people) {
      const phone = uaePhone();
      const contact = await seedContact(ctx, phone, { name: p.name, attributes: p.attributes ?? {} });
      await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
      phones.push(phone);
    }
    return { tagName, phones };
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    manager = await signIn(ctx, 'MANAGER');
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
    number = await seedNumber(ctx);
    fake = new FakeTemplatesGraph().install();
    const components = [
      { type: 'HEADER', format: 'DOCUMENT' },
      { type: 'BODY', text: 'Hi {{1}}, your invoice is attached.' },
    ];
    const template = await seedTemplate(ctx, number.wabaId, { category: 'UTILITY', components, variables: [{ key: 'BODY.1', example: 'Sara' }] });
    fake.know({ wabaId: number.wabaId, name: template.name, language: template.language, category: 'UTILITY', components });
    templateId = template.id;
    templateName = template.name;
  });
  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await ctx.close();
  });

  it('sends one checked address to everyone with `link`, and a failed send keeps Meta\'s code', async () => {
    nock(FILES).persist().head('/ok.pdf').reply(200, '', PDF);
    const { tagName, phones } = await tagged([{ name: 'Sara' }, { name: 'Omar' }]);
    const id = await filterCampaign(tagName, { source: 'static', value: `${FILES}/ok.pdf` });
    const check = await api('post', `/campaigns/${id}/media-check`);
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body).toMatchObject({ checked: 1, sampled: false, problems: [], cardMedia: [] });
    expect((await api('post', `/campaigns/${id}/launch`)).status).toBe(200);

    fake.failSends.set(number.phoneNumberId, { status: 400, code: 131053, message: 'Media upload error' });
    const [first] = await ctx.prisma.message.findMany({ where: { campaignId: id }, orderBy: { phoneE164: 'asc' }, take: 1 });
    await ctx.app.get(DispatcherProcessor).tick(id);
    await ctx.app.get(SendProcessor).process(first!.id, 5);
    fake.failSends.delete(number.phoneNumberId);
    expect(await ctx.prisma.message.findUniqueOrThrow({ where: { id: first!.id } })).toMatchObject({ failureCode: 131053 });

    for (const m of await ctx.prisma.message.findMany({ where: { campaignId: id, status: 'QUEUED' } })) await ctx.app.get(SendProcessor).process(m.id, 1);
    await dispatchAndSend(id);
    const others = phones.filter((p) => p !== first!.phoneE164);
    for (const phone of others) {
      const header = (fake.sentTo(phone).at(-1)!.body.template.components as Array<{ type: string; parameters?: unknown[] }>).find((c) => c.type === 'header');
      expect(header?.parameters).toEqual([{ type: 'document', document: { link: `${FILES}/ok.pdf` } }]);
    }
  });

  it('skips recipients without an address from an attribute', async () => {
    const { tagName, phones } = await tagged([{ name: 'Sara', attributes: { invoice_url: `${FILES}/sara.pdf` } }, { name: 'Omar' }]);
    const id = await filterCampaign(tagName, { source: 'attribute', key: 'invoice_url' });
    expect((await api('post', `/campaigns/${id}/launch`)).status).toBe(200);
    const byPhone = new Map((await ctx.prisma.message.findMany({ where: { campaignId: id } })).map((m) => [m.phoneE164, m]));
    expect(byPhone.get(phones[1]!)).toMatchObject({ status: 'SKIPPED', skipReason: 'MEDIA_URL_MISSING' });
    expect((byPhone.get(phones[0]!)!.resolvedParams as Record<string, string>).$headerMediaUrl).toBe(`${FILES}/sara.pdf`);
  });

  it('reports each bad address of an upload with its rows, blocks the launch, and launches after the fix', async () => {
    const files = nock(FILES).persist();
    files.head('/ok.pdf').reply(200, '', PDF);
    files.head('/page.html').reply(200, '', { 'content-type': 'text/html' });
    files.head('/huge.pdf').reply(200, '', { 'content-type': 'application/pdf', 'content-length': String(200 * 1024 * 1024) });
    files.head('/slow.pdf').delay(6_000).reply(200, '', PDF);
    files.head('/nohead.pdf').reply(405, '');
    files.get('/nohead.pdf').reply(206, '%', { 'content-type': 'application/pdf', 'content-range': 'bytes 0-0/4096' });
    const id = await uploadCampaign([`${FILES}/ok.pdf`, `${FILES}/page.html`, `${FILES}/huge.pdf`, `${FILES}/slow.pdf`, `${FILES}/nohead.pdf`, 'http://files.example.com/a.pdf', 'https://10.0.0.5/a.pdf', `${FILES}/ok.pdf`]);
    const check = await api('post', `/campaigns/${id}/media-check`);
    expect(check.status, JSON.stringify(check.body)).toBe(200);
    expect(check.body.checked).toBe(7);
    const reasons = Object.fromEntries((check.body.problems as Array<{ url: string; reason: string; rows: number[] }>).map((p) => [p.url, `${p.reason}:${p.rows.join(',')}`]));
    expect(reasons).toEqual({
      [`${FILES}/page.html`]: 'WRONG_TYPE:3',
      [`${FILES}/huge.pdf`]: 'TOO_LARGE:4',
      [`${FILES}/slow.pdf`]: 'TIMEOUT:5',
      'http://files.example.com/a.pdf': 'NOT_HTTPS:7',
      'https://10.0.0.5/a.pdf': 'NOT_PUBLIC:8',
    });
    const refused = await api('post', `/campaigns/${id}/launch`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('MEDIA_PROBLEMS');

    // The fix: every bad row now points to a good file.
    const rows = await ctx.prisma.campaignUploadRow.findMany({ where: { campaignId: id } });
    for (const row of rows) {
      const data = row.data as Record<string, string>;
      if (!data.invoice_url?.endsWith('/ok.pdf') && !data.invoice_url?.endsWith('/nohead.pdf')) await ctx.prisma.campaignUploadRow.update({ where: { id: row.id }, data: { data: { ...data, invoice_url: `${FILES}/ok.pdf` } } });
    }
    const fixed = await api('post', `/campaigns/${id}/media-check`);
    expect(fixed.body).toMatchObject({ checked: 2, problems: [] });
  });

  it('samples 1,000 of more distinct addresses and shows at most 50 problems', async () => {
    nock('https://bulk.example.com').persist().head(/^\/f\d+\.pdf$/).reply(200, '', PDF);
    const many = await uploadCampaign(Array.from({ length: 1_001 }, (_, i) => `https://bulk.example.com/f${i}.pdf`));
    const sampled = await api('post', `/campaigns/${many}/media-check`);
    expect(sampled.status, JSON.stringify(sampled.body)).toBe(200);
    expect(sampled.body).toMatchObject({ checked: 1_000, sampled: true, problems: [] });

    const bad = await uploadCampaign(Array.from({ length: 60 }, (_, i) => `http://plain.example.com/f${i}.pdf`));
    const check = await api('post', `/campaigns/${bad}/media-check`);
    expect(check.body.checked).toBe(60);
    expect(check.body.problems).toHaveLength(50);
    const refused = await api('post', `/campaigns/${bad}/launch`);
    expect(refused.status).toBe(422);
    expect(refused.body.code).toBe('MEDIA_PROBLEMS');
    expect(refused.body.details.length).toBeLessThanOrEqual(50);
  });

  it('keeps the public API https-only for media addresses (400, as the 001 public API answers bad bodies)', async () => {
    const created = await admin.agent.post('/api/api-keys').set('X-CSRF-Token', admin.csrf).send({ name: `Media key ${digits(5)}`, rateLimitPerMinute: 600 });
    expect(created.status).toBe(201);
    const send = (headerMediaUrl: string) =>
      request(ctx.server())
        .post('/api/v1/messages')
        .set('authorization', `Bearer ${created.body.secret}`)
        .send({ numberId: number.id, to: uaePhone(), template: { name: templateName, language: 'en_US' }, params: { 'BODY.1': 'Sara' }, headerMediaUrl });
    expect((await send('http://files.example.com/a.pdf')).status).toBe(400);
  });
});
