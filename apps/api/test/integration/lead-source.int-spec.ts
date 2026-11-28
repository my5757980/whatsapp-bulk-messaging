import { randomInt } from 'node:crypto';
import { makeChatRef, makeLinkCode, messageWithRef } from '@wbm/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContactsService } from '../../src/modules/contacts/contacts.service.js';
import { ImportProcessor } from '../../src/modules/imports/import.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { csvFile, digits, seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T032 (feature 010 US2, FR-011, FR-012, research R5): every entry point sets the lead source once.
describe('Lead source (010 US2)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;

  const inbound = async (phone: string, text: string, extra: Record<string, unknown> = {}) =>
    ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), text, extra)));
  const source = async (phone: string) => {
    const c = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone }, select: { leadSourceKind: true, leadSource: true } });
    return [c.leadSourceKind, c.leadSource];
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
  });
  afterAll(async () => ctx.close());

  it('organic first messages, the API, the dashboard and imports with a label', async () => {
    const organic = uaePhone();
    await inbound(organic, 'Hi, do you deliver?');
    expect(await source(organic)).toEqual(['ORGANIC', null]);

    const api = uaePhone();
    await ctx.app.get(ContactsService).create({ phone: api, name: 'From the API', leadSourceLabel: 'CRM sync' }, null, 'api');
    expect(await source(api)).toEqual(['API', 'CRM sync']);

    const manual = uaePhone();
    expect((await admin.agent.post('/api/contacts').set('X-CSRF-Token', admin.csrf).send({ phone: manual, name: 'By hand' })).status).toBe(201);
    expect(await source(manual)).toEqual(['CUSTOM', 'Added by hand']);

    const imported = `+9715066${digits(5)}`;
    const started = await admin.agent
      .post('/api/imports')
      .set('X-CSRF-Token', admin.csrf)
      .field('mapping', JSON.stringify({ phone: 'phone', name: 'full_name' }))
      .field('leadSourceLabel', 'Expo leads')
      .attach('file', csvFile(['phone,full_name', `${imported},Expo visitor`]), { filename: 'contacts.csv', contentType: 'text/csv' });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    await ctx.app.get(ImportProcessor).process(started.body.id);
    expect(await source(imported)).toEqual(['IMPORT', 'Expo leads']);
  });

  it('a first message through a chat link, the website button or an ad records that source', async () => {
    const link = await ctx.prisma.chatLink.create({
      data: { name: `Flyer ${digits(6)}`, numberId: number.id, message: 'Hi, I saw your flyer', ref: makeChatRef((max) => randomInt(max)), code: makeLinkCode((max) => randomInt(max)) },
    });
    const viaLink = uaePhone();
    await inbound(viaLink, messageWithRef(link.message, link.ref));
    expect(await source(viaLink)).toEqual(['CHAT_LINK', link.name]);

    const widget = await admin.agent
      .post('/api/chat-widgets')
      .set('X-CSRF-Token', admin.csrf)
      .send({
        name: `Site ${digits(6)}`,
        numberId: number.id,
        look: { colour: '#25D366', buttonText: 'Chat', corner: 'BOTTOM_RIGHT', offsetX: 20, offsetY: 20, radius: 24 },
        brandName: 'Shop',
        brandImageAssetId: null,
        greeting: 'Hi!',
        message: 'Hello from the website',
        rules: [],
      });
    expect(widget.status, JSON.stringify(widget.body)).toBe(201);
    const widgetLink = await ctx.prisma.chatLink.findFirstOrThrow({ where: { widgetId: widget.body.id } });
    const viaButton = uaePhone();
    await inbound(viaButton, messageWithRef(widgetLink.message, widgetLink.ref));
    expect(await source(viaButton)).toEqual(['WEBSITE_BUTTON', null]);

    const viaAd = uaePhone();
    await inbound(viaAd, 'I saw your ad', { referral: { source_url: 'https://fb.me/abc', source_id: `${digits(12)}`, source_type: 'ad', headline: 'Lamp sale', body: 'Today only', ctwa_clid: `clid-${digits(8)}` } });
    expect((await source(viaAd))[0]).toBe('AD');
  });

  it('never changes the source later, and the list filters by it', async () => {
    const phone = uaePhone();
    await inbound(phone, 'First message');
    const link = await ctx.prisma.chatLink.create({
      data: { name: `Later ${digits(6)}`, numberId: number.id, message: 'Hi again', ref: makeChatRef((max) => randomInt(max)), code: makeLinkCode((max) => randomInt(max)) },
    });
    await inbound(phone, messageWithRef(link.message, link.ref));
    expect(await source(phone)).toEqual(['ORGANIC', null]);
    const listed = await admin.agent.get('/api/contacts').query({ leadSource: 'IMPORT', q: 'Expo visitor' });
    expect(listed.body.items.every((c: { leadSource: string }) => c.leadSource === 'IMPORT')).toBe(true);
    expect(listed.body.items.length).toBeGreaterThanOrEqual(1);
  });
});
