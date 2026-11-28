import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
import { KEYWORD_REPLY_PARAM } from '../../src/modules/sending/template-payload.builder.js';
import { keywordReplyKey } from '../../src/modules/settings/keyword-replies.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import {
  mockMetaSends,
  restoreNetwork,
  seedContact,
  seedNumber,
  seedTemplate,
  setDefaultCountry,
  uaePhone,
  useNockLocalOnly,
  type SentCall,
} from '../support/fixtures.js';
import {
  createTestContext,
  postSignedWebhook,
  signIn,
  webhook,
  type SignedInAgent,
  type TestContext,
} from '../support/test-context.js';

// T050 (feature 010 US4, FR-017, FR-018, research R8): the confirmation reply after an opt-out or opt-in keyword.
describe('Keyword replies (010 US4)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let utilityId: string;
  let marketingId: string;
  let stop: string;
  let start: string;
  const OUT_TEXT = 'You will get no more messages from us. Reply START to come back.';

  const send = (who: SignedInAgent, method: 'put' | 'patch', path: string, body: object) =>
    who.agent[method](`/api${path}`).set('X-CSRF-Token', who.csrf).send(body);
  const setReplies = (body: object) => send(admin, 'put', '/settings/keyword-replies', body);
  const inbound = async (
    to: { id: string; phoneNumberId: string },
    phone: string,
    text: string,
  ) => {
    await ctx.app
      .get(WebhooksProcessor)
      .process(
        await postSignedWebhook(ctx, webhook.inbound(to.phoneNumberId, phone.slice(1), text)),
      );
    return ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } });
  };
  const automaticItems = (contactId: string) =>
    ctx.prisma.chatMessage.findMany({
      where: { conversation: { contactId }, origin: 'AUTOMATIC' },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      include: { message: true },
    });
  const templateReply = {
    kind: 'TEMPLATE',
    templateId: '',
    variables: { 'BODY.1': { source: 'field', key: 'name', fallback: 'there' } },
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    [admin, manager] = await Promise.all([signIn(ctx, 'ADMIN'), signIn(ctx, 'MANAGER')]);
    number = await seedNumber(ctx);
    utilityId = (await seedTemplate(ctx, number.wabaId, { category: 'UTILITY' })).id;
    marketingId = (await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' })).id;
    templateReply.templateId = utilityId;
    const settings = (await admin.agent.get('/api/settings')).body as {
      optOutKeywords: string[];
      optInKeywords: string[];
    };
    [stop, start] = [settings.optOutKeywords[0]!, settings.optInKeywords[0]!];
  });

  afterAll(async () => {
    await setReplies({ optOut: { kind: 'NONE' }, optIn: { kind: 'NONE' } });
    restoreNetwork();
    await ctx.close();
  });

  it('keeps the replies for admins, with template checks and an audit entry', async () => {
    const before = await admin.agent.get('/api/settings/keyword-replies');
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      optOut: { kind: expect.any(String) },
      optIn: { kind: expect.any(String) },
    });

    const marketing = await setReplies({
      optOut: { kind: 'NONE' },
      optIn: { ...templateReply, templateId: marketingId },
    });
    expect(marketing.status).toBe(422);
    expect(marketing.body.code).toBe('TEMPLATE_NOT_UTILITY');
    expect(
      (
        await setReplies({
          optOut: { kind: 'TEXT', text: 'x'.repeat(1025) },
          optIn: { kind: 'NONE' },
        })
      ).status,
    ).toBe(422);
    const unmapped = await setReplies({
      optOut: { kind: 'NONE' },
      optIn: { kind: 'TEMPLATE', templateId: utilityId },
    });
    expect(unmapped.status).toBe(422);
    expect(unmapped.body.details).toContainEqual({
      field: 'optIn.variables.BODY.1',
      issue: 'needs a value',
    });
    expect(
      (
        await send(manager, 'put', '/settings/keyword-replies', {
          optOut: { kind: 'NONE' },
          optIn: { kind: 'NONE' },
        })
      ).status,
    ).toBe(403);
    expect((await manager.agent.get('/api/settings/keyword-replies')).status).toBe(200);

    const saved = await setReplies({
      optOut: { kind: 'TEXT', text: OUT_TEXT },
      optIn: templateReply,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toEqual({
      optOut: { kind: 'TEXT', text: OUT_TEXT, templateId: null, variables: {} },
      optIn: {
        kind: 'TEMPLATE',
        text: null,
        templateId: utilityId,
        variables: templateReply.variables,
      },
    });
    expect((await admin.agent.get('/api/settings/keyword-replies')).body).toEqual(saved.body);
    expect(
      await ctx.prisma.auditLog.count({ where: { action: 'keyword_replies.changed' } }),
    ).toBeGreaterThanOrEqual(1);
  });

  it('answers an opt-out with the text reply in the chat, once a day', async () => {
    const phone = uaePhone();
    const contact = await inbound(number, phone, stop);
    expect(contact.consentStatus).toBe('OPTED_OUT');
    const items = await automaticItems(contact.id);
    expect(items).toEqual([
      expect.objectContaining({
        kind: 'SESSION_OUT',
        contentType: 'TEXT',
        text: OUT_TEXT,
        status: 'QUEUED',
      }),
    ]);

    await inbound(number, phone, stop.toLowerCase());
    expect(await automaticItems(contact.id)).toHaveLength(1);
  });

  it('answers an opt-in with the utility template reply', async () => {
    const phone = uaePhone();
    await seedContact(ctx, phone, { consentStatus: 'OPTED_OUT', name: null });
    const contact = await inbound(number, phone, start);
    expect(contact.consentStatus).toBe('OPTED_IN');
    const [item, ...rest] = await automaticItems(contact.id);
    expect(rest).toEqual([]);
    expect(item).toMatchObject({ kind: 'MESSAGE_REF', contentType: 'TEMPLATE' });
    expect(item!.message).toMatchObject({
      origin: 'INBOX',
      automatic: true,
      templateId: utilityId,
      status: 'QUEUED',
      resolvedParams: { 'BODY.1': 'there', [KEYWORD_REPLY_PARAM]: '1' },
    });
  });

  it('sends a template confirmation to the person who has just opted out', async () => {
    expect((await setReplies({ optOut: templateReply, optIn: { kind: 'NONE' } })).status).toBe(200);
    const phone = uaePhone();
    const contact = await inbound(number, phone, stop);
    expect(contact.consentStatus).toBe('OPTED_OUT');
    const [item] = await automaticItems(contact.id);
    expect(item?.message).toMatchObject({ templateId: utilityId, status: 'QUEUED' });

    const calls: SentCall[] = [];
    mockMetaSends(number.phoneNumberId, [phone], calls);
    await ctx.app.get(SendProcessor).process(item!.message!.id, 1);
    expect(
      await ctx.prisma.message.findUniqueOrThrow({ where: { id: item!.message!.id } }),
    ).toMatchObject({ status: 'SENT' });
    expect(calls).toHaveLength(1);

    // An opt-in with no reply set sends nothing.
    await inbound(number, phone, start);
    expect(await automaticItems(contact.id)).toHaveLength(1);
  });

  it('sends nothing to blocked contacts or from a number whose sending is off', async () => {
    expect(
      (await setReplies({ optOut: { kind: 'TEXT', text: OUT_TEXT }, optIn: { kind: 'NONE' } }))
        .status,
    ).toBe(200);
    const blockedPhone = uaePhone();
    const blocked = await seedContact(ctx, blockedPhone, { blockedAt: new Date() });
    await inbound(number, blockedPhone, stop);
    expect(await automaticItems(blocked.id)).toEqual([]);

    const paused = await seedNumber(ctx, { sendingEnabled: false });
    const phone = uaePhone();
    const contact = await inbound(paused, phone, stop);
    expect(contact.consentStatus).toBe('OPTED_OUT');
    expect(await automaticItems(contact.id)).toEqual([]);
    // The day's reply is not used up by a reply that was never sent.
    expect(
      await ctx.app.get<Redis>(REDIS_CLIENT).exists(keywordReplyKey('OPT_OUT', contact.id)),
    ).toBe(0);
  });

  it('refuses a keyword in both lists (001 settings)', async () => {
    const settings = (await admin.agent.get('/api/settings')).body as {
      optOutKeywords: string[];
      optInKeywords: string[];
    };
    const both = await send(admin, 'patch', '/settings', {
      optInKeywords: [...settings.optInKeywords, settings.optOutKeywords[0]],
    });
    expect(both.status).toBe(422);
    expect((await admin.agent.get('/api/settings')).body.optInKeywords).toEqual(
      settings.optInKeywords,
    );
  });
});
