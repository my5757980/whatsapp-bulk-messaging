import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DispatcherProcessor } from '../../src/modules/sending/dispatcher.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { mockMetaSends, restoreNetwork, seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone, useNockLocalOnly, type SentCall } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, uniq, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T016 (feature 005, US1, FR-001 - FR-009): tracked links in a campaign, real clicks only, results,
// the journey and the chat timeline.
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36';
const WHATSAPP_PREVIEW_UA = 'WhatsApp/2.24.20.72 A';

describe('Tracked links and clicks (005 US1)', () => {
  let ctx: TestContext;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let numberId: string;
  let phoneNumberId: string;
  let templateId: string;
  let campaignId: string;
  const campaignName = `Summer Sale ${uniq('')}`;
  const base = process.env.PUBLIC_LINK_BASE_URL as string;
  const tagName = uniq('clicks');
  const contacts: Array<{ id: string; phoneE164: string }> = [];
  const calls: SentCall[] = [];

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put' | 'patch', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const open = (code: string, userAgent = PHONE_UA) => request(ctx.server()).get(`/l/${code}`).set('User-Agent', userAgent);
  const codeOf = async (contactId: string, variableKey: string) =>
    (await ctx.prisma.trackedLink.findFirstOrThrow({ where: { contactId, message: { campaignId }, target: { variableKey } } })).code;

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
    const number = await seedNumber(ctx);
    numberId = number.id;
    phoneNumberId = number.phoneNumberId;
    const template = await seedTemplate(ctx, number.wabaId, {
      components: [
        { type: 'BODY', text: 'Hi {{1}}, see our menu: {{2}}', example: { body_text: [['Sara', `${base}/AbCdEf1234`]] } },
        {
          type: 'BUTTONS',
          buttons: [
            { type: 'URL', text: 'Shop now', url: `${base}/{{1}}`, example: [`${base}/AbCdEf1234`] },
            { type: 'URL', text: 'Our site', url: 'https://shop.example/{{1}}', example: ['https://shop.example/home'] },
          ],
        },
      ],
      variables: [
        { key: 'BODY.1', example: 'Sara' },
        { key: 'BODY.2', example: `${base}/AbCdEf1234` },
        { key: 'BUTTON.0.1', example: `${base}/AbCdEf1234` },
        { key: 'BUTTON.1.1', example: 'home' },
      ],
    });
    templateId = template.id;
    const tag = await ctx.prisma.tag.create({ data: { name: tagName } });
    for (const [i, consentStatus] of (['OPTED_IN', 'OPTED_IN', 'OPTED_IN', 'OPTED_OUT'] as const).entries()) {
      const contact = await seedContact(ctx, uaePhone(), { consentStatus, name: `Clicker ${i + 1}` });
      contacts.push(contact);
      await ctx.prisma.contactTag.create({ data: { contactId: contact.id, tagId: tag.id } });
    }
    // A chat with the first contact, so its timeline and journey can show the clicks.
    await ctx.prisma.conversation.create({ data: { contactId: contacts[0]!.id, numberId, state: 'ACTIVE', lastCustomerMessageAt: new Date() } });
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('gives the template editor the tracked-link address', async () => {
    const res = await api(agent, 'get', '/tracked-links/config');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ enabled: true, baseUrl: base, buttonUrl: `${base}/{{1}}` });
  });

  it('lists the variables that can carry a tracked link and refuses the others', async () => {
    const draft = await api(manager, 'post', '/campaigns', {
      name: campaignName,
      numberId,
      templateId,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag: tagName }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' }, 'BUTTON.1.1': { source: 'static', value: 'home' } },
    });
    expect(draft.status).toBe(201);
    campaignId = draft.body.id;

    const before = await api(agent, 'get', `/campaigns/${campaignId}/tracked-links`);
    expect(before.status).toBe(200);
    expect(before.body.links).toEqual([]);
    expect(before.body.trackable).toEqual([
      { variableKey: 'BODY.1', kind: 'TEXT_VARIABLE', trackable: true, reason: null },
      { variableKey: 'BODY.2', kind: 'TEXT_VARIABLE', trackable: true, reason: null },
      { variableKey: 'BUTTON.0.1', kind: 'URL_BUTTON', trackable: true, reason: null },
      { variableKey: 'BUTTON.1.1', kind: 'URL_BUTTON', trackable: false, reason: expect.stringMatching(/tracked-link address/i) },
    ]);

    const put = (links: object[]) => api(manager, 'put', `/campaigns/${campaignId}/tracked-links`, { links });
    expect((await put([{ variableKey: 'BUTTON.1.1', destination: 'https://shop.example/x' }])).body.code).toBe('LINK_NOT_TRACKABLE');
    expect((await put([{ variableKey: 'BODY.9', destination: 'https://shop.example/x' }])).body.code).toBe('LINK_NOT_TRACKABLE');
    expect((await put([{ variableKey: 'BUTTON.0.1', destination: 'ftp://shop.example/x' }])).body.code).toBe('BAD_DESTINATION');
    expect((await put([{ variableKey: 'BUTTON.0.1', destination: `${base}/ZZZZZZZZZZ` }])).body.code).toBe('BAD_DESTINATION');
    const twice = await put([
      { variableKey: 'BUTTON.0.1', destination: 'https://shop.example/a' },
      { variableKey: 'BUTTON.0.1', destination: 'https://shop.example/b' },
    ]);
    expect(twice.status).toBe(422);
    expect(twice.body.code).toBe('VALIDATION_FAILED');
    expect((await api(agent, 'put', `/campaigns/${campaignId}/tracked-links`, { links: [] })).status).toBe(403);

    const saved = await put([
      { variableKey: 'BUTTON.0.1', destination: 'https://shop.example/sale', addCampaignTags: true },
      { variableKey: 'BODY.2', destination: 'https://shop.example/menu' },
    ]);
    expect(saved.status).toBe(200);
    expect(saved.body.links).toEqual([
      { id: expect.any(String), variableKey: 'BODY.2', destination: 'https://shop.example/menu', addCampaignTags: false },
      { id: expect.any(String), variableKey: 'BUTTON.0.1', destination: 'https://shop.example/sale', addCampaignTags: true },
    ]);
  });

  it('counts tracked variables as filled in the estimate and gives every recipient their own codes at launch', async () => {
    const estimate = await api(manager, 'post', `/campaigns/${campaignId}/estimate`);
    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({ eligible: 3, excluded: { optedOut: 1, missingVariable: 0 } });

    const launched = await api(manager, 'post', `/campaigns/${campaignId}/launch`, {});
    expect(launched.status).toBe(200);
    const messages = await ctx.prisma.message.findMany({ where: { campaignId }, include: { trackedLinks: { include: { target: true } } } });
    const pending = messages.filter((m) => m.status === 'PENDING');
    expect(pending).toHaveLength(3);
    expect(messages.find((m) => m.status === 'SKIPPED')?.trackedLinks).toEqual([]);
    const codes = new Set<string>();
    for (const message of pending) {
      expect(message.trackedLinks).toHaveLength(2);
      const params = message.resolvedParams as Record<string, string>;
      for (const link of message.trackedLinks) {
        expect(link.code).toMatch(/^[0-9A-Za-z]{10}$/);
        expect(link.contactId).toBe(message.contactId);
        codes.add(link.code);
        expect(params[link.target.variableKey]).toBe(link.target.variableKey === 'BUTTON.0.1' ? link.code : `${base}/${link.code}`);
      }
      expect(params['BUTTON.1.1']).toBe('home');
    }
    expect(codes.size).toBe(6);

    const late = await api(manager, 'put', `/campaigns/${campaignId}/tracked-links`, { links: [] });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('CAMPAIGN_NOT_EDITABLE');
  });

  it('sends each recipient their own code in the button and their own link in the text', async () => {
    await ctx.app.get(DispatcherProcessor).tick(campaignId);
    const queued = await ctx.prisma.message.findMany({ where: { campaignId, status: 'QUEUED' } });
    expect(queued).toHaveLength(3);
    mockMetaSends(phoneNumberId, queued.map((m) => m.phoneE164!), calls);
    for (const message of queued) expect((await ctx.app.get(SendProcessor).process(message.id, 1)).result).toBe('sent');

    const first = contacts[0]!;
    const call = calls.find((c) => c.to === first.phoneE164.slice(1))!;
    const components = (call.body.template as { components: Array<{ type: string; index?: string; parameters: Array<{ text: string }> }> }).components;
    expect(components.find((c) => c.type === 'button' && c.index === '0')?.parameters[0]?.text).toBe(await codeOf(first.id, 'BUTTON.0.1'));
    expect(components.find((c) => c.type === 'button' && c.index === '1')?.parameters[0]?.text).toBe('home');
    expect(components.find((c) => c.type === 'body')?.parameters[1]?.text).toBe(`${base}/${await codeOf(first.id, 'BODY.2')}`);

    const processor = ctx.app.get(WebhooksProcessor);
    for (const message of queued) {
      const to = message.phoneE164!.slice(1);
      await processor.process(await postSignedWebhook(ctx, webhook.status(phoneNumberId, `wamid.${to}`, to, 'delivered')));
    }
  });

  it('counts real clicks only and sends every visitor on to the destination', async () => {
    const [a, b, c] = contacts;
    const buttonA = await codeOf(a!.id, 'BUTTON.0.1');
    const first = await open(buttonA);
    expect(first.status).toBe(302);
    expect(first.headers.location).toBe(`https://shop.example/sale?utm_source=whatsapp&utm_medium=message&utm_campaign=${encodeURIComponent(campaignName)}`);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.headers['referrer-policy']).toBe('no-referrer');
    expect((await open(buttonA, DESKTOP_UA)).status).toBe(302);

    const menuB = await open(await codeOf(b!.id, 'BODY.2'));
    expect(menuB.status).toBe(302);
    expect(menuB.headers.location).toBe('https://shop.example/menu');

    // WhatsApp's link preview and a HEAD request are sent on but never counted (FR-004).
    expect((await open(await codeOf(c!.id, 'BUTTON.0.1'), WHATSAPP_PREVIEW_UA)).status).toBe(302);
    expect((await request(ctx.server()).head(`/l/${await codeOf(c!.id, 'BUTTON.0.1')}`).set('User-Agent', PHONE_UA)).status).toBe(302);

    const clicks = await ctx.prisma.linkClick.findMany({ where: { campaignId }, orderBy: { clickedAt: 'asc' } });
    expect(clicks.map((k) => [k.contactId, k.device])).toEqual([
      [a!.id, 'MOBILE'],
      [a!.id, 'DESKTOP'],
      [b!.id, 'MOBILE'],
    ]);

    // Unknown and malformed codes show a page and send nobody onward (FR-005).
    for (const code of ['ZZZZZZZZZZ', 'short']) {
      const missing = await open(code);
      expect(missing.status).toBe(404);
      expect(missing.headers.location).toBeUndefined();
      expect(missing.text).toMatch(/not available/i);
    }
  });

  it('shows clickers, clicks per link and the click rate, with phones masked for agents', async () => {
    const summary = await api(agent, 'get', `/campaigns/${campaignId}/clicks/summary`);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ clickers: 2, clicks: 3, delivered: 3 });
    expect(summary.body.clickRate).toBeCloseTo(2 / 3, 5);
    expect(summary.body.links).toEqual([
      { targetId: expect.any(String), variableKey: 'BODY.2', destination: 'https://shop.example/menu', clickers: 1, clicks: 1 },
      { targetId: expect.any(String), variableKey: 'BUTTON.0.1', destination: 'https://shop.example/sale', clickers: 1, clicks: 2 },
    ]);

    const [a, b] = contacts;
    const view = await api(manager, 'get', `/campaigns/${campaignId}/clicks?page=1&pageSize=50`);
    expect(view.status).toBe(200);
    expect(view.body.total).toBe(2);
    const rowA = (view.body.items as Array<Record<string, unknown>>).find((r) => r.contactId === a!.id)!;
    expect(rowA).toMatchObject({ name: 'Clicker 1', phone: a!.phoneE164, clicks: 2 });
    expect(new Date(rowA.firstClickAt as string).getTime()).toBeLessThanOrEqual(new Date(rowA.lastClickAt as string).getTime());
    expect((view.body.items as Array<Record<string, unknown>>).find((r) => r.contactId === b!.id)).toMatchObject({ clicks: 1 });

    const masked = await api(agent, 'get', `/campaigns/${campaignId}/clicks`);
    expect(masked.status).toBe(200);
    for (const row of masked.body.items as Array<{ phone: string }>) expect(row.phone).not.toMatch(/^\+971/);

    expect((await api(agent, 'get', `/campaigns/${campaignId}/clicks/export`)).status).toBe(403);
    const csv = await api(manager, 'get', `/campaigns/${campaignId}/clicks/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    const lines = csv.text.trim().split('\n');
    expect(lines[0]).toBe('phone,name,clicks,first_click_at,last_click_at');
    expect(lines).toHaveLength(3);
    expect(csv.text).toContain(a!.phoneE164);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'data.exported', targetId: campaignId } })).toBeGreaterThanOrEqual(1);
  });

  it('adds the click to the journey and shows the first click on the message in the chat', async () => {
    const a = contacts[0]!;
    const chat = await ctx.prisma.conversation.findFirstOrThrow({ where: { contactId: a.id, numberId } });
    const journey = await api(manager, 'get', `/inbox/conversations/${chat.id}/journey`);
    expect(journey.status).toBe(200);
    const clicked = (journey.body as Array<{ type: string; data: Record<string, unknown> }>).filter((e) => e.type === 'LINK_CLICKED');
    expect(clicked).toHaveLength(2);
    expect(clicked[0]!.data).toMatchObject({ campaignId, campaignName, destination: 'https://shop.example/sale' });

    const items = await api(manager, 'get', `/inbox/conversations/${chat.id}/items`);
    expect(items.status).toBe(200);
    const ref = (items.body.items as Array<Record<string, unknown>>).find((i) => i.kind === 'MESSAGE_REF')!;
    const firstClick = await ctx.prisma.linkClick.findFirstOrThrow({ where: { contactId: a.id, campaignId }, orderBy: { clickedAt: 'asc' } });
    expect(ref.firstClickAt).toBe(firstClick.clickedAt.toISOString());
  });

  it('sends new clicks to a changed destination and audits the change', async () => {
    const target = await ctx.prisma.trackedLinkTarget.findFirstOrThrow({ where: { campaignId, variableKey: 'BODY.2' } });
    expect((await api(manager, 'patch', `/tracked-link-targets/${target.id}`, { destination: 'ftp://nope' })).status).toBe(422);
    expect((await api(agent, 'patch', `/tracked-link-targets/${target.id}`, { destination: 'https://shop.example/new-menu' })).status).toBe(403);
    const changed = await api(manager, 'patch', `/tracked-link-targets/${target.id}`, { destination: 'https://shop.example/new-menu' });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ id: target.id, variableKey: 'BODY.2', destination: 'https://shop.example/new-menu', addCampaignTags: false });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'tracked_link.destination_changed', targetId: target.id } })).toBe(1);

    const again = await open(await codeOf(contacts[1]!.id, 'BODY.2'));
    expect(again.headers.location).toBe('https://shop.example/new-menu');
  });
});
