import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { digits, seedContact, seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, webhook, type TestContext } from '../support/test-context.js';

// T079: STOP/START keywords from signed inbound webhooks (FR-012-FR-014, research R12).
describe('Consent keywords', () => {
  let ctx: TestContext;
  let phoneNumberId: string;

  const inbound = async (from: string, text: string, id?: string) => {
    const payload = webhook.inbound(phoneNumberId, from.slice(1), text);
    if (id) (payload.entry[0]!.changes[0]!.value.messages[0] as { id: string }).id = id;
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
  };
  const contact = (phone: string) =>
    ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone }, include: { consentEvents: { orderBy: { createdAt: 'asc' } } } });

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { optOutKeywords: ['STOP', 'UNSUBSCRIBE'], optInKeywords: ['START'] } });
    phoneNumberId = (await seedNumber(ctx)).phoneNumberId;
  });
  afterAll(async () => ctx.close());

  it('opts a contact out for STOP in any case and with extra spaces, and back in for START', async () => {
    const phone = uaePhone();
    await seedContact(ctx, phone, { consentStatus: 'OPTED_IN' });

    await inbound(phone, 'stop');
    expect((await contact(phone)).consentStatus).toBe('OPTED_OUT');

    await inbound(phone, 'START');
    expect((await contact(phone)).consentStatus).toBe('OPTED_IN');

    await inbound(phone, '  Unsubscribe  ');
    const after = await contact(phone);
    expect(after).toMatchObject({ consentStatus: 'OPTED_OUT', consentSource: 'KEYWORD' });
    expect(after.consentEvents.map((e) => [e.status, e.source])).toEqual([
      ['OPTED_OUT', 'KEYWORD'],
      ['OPTED_IN', 'KEYWORD'],
      ['OPTED_OUT', 'KEYWORD'],
    ]);
  });

  it('ignores sentences that only contain a keyword', async () => {
    const phone = uaePhone();
    await seedContact(ctx, phone, { consentStatus: 'OPTED_IN' });
    await inbound(phone, "please don't stop sending");
    expect((await contact(phone)).consentStatus).toBe('OPTED_IN');
  });

  it('creates unknown senders', async () => {
    const stopper = uaePhone();
    await inbound(stopper, 'STOP');
    expect(await contact(stopper)).toMatchObject({ consentStatus: 'OPTED_OUT', consentSource: 'KEYWORD', countryCode: 'AE' });

    const chatter = uaePhone();
    await inbound(chatter, 'hello there');
    expect(await contact(chatter)).toMatchObject({ consentStatus: 'UNKNOWN', consentEvents: [] });
  });

  it('processes each inbound message id once', async () => {
    const phone = uaePhone();
    await seedContact(ctx, phone, { consentStatus: 'OPTED_IN' });
    const stopId = `wamid.in.${digits(10)}`;
    await inbound(phone, 'STOP', stopId);
    await inbound(phone, 'START');
    await inbound(phone, 'STOP', stopId); // Meta re-delivery of the first message
    expect((await contact(phone)).consentStatus).toBe('OPTED_IN');
  });

  it('respects edited keyword lists', async () => {
    await ctx.prisma.settings.update({ where: { id: 1 }, data: { optOutKeywords: ['CANCEL'], optInKeywords: ['YES'] } });
    const phone = uaePhone();
    await seedContact(ctx, phone, { consentStatus: 'OPTED_IN' });

    await inbound(phone, 'STOP');
    expect((await contact(phone)).consentStatus).toBe('OPTED_IN');
    await inbound(phone, 'cancel');
    expect((await contact(phone)).consentStatus).toBe('OPTED_OUT');
    await inbound(phone, 'yes');
    expect((await contact(phone)).consentStatus).toBe('OPTED_IN');
  });
});
