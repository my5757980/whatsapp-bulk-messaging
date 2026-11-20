import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedContact, seedNumber, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T077: US6 - welcome and off-hours messages, sent exactly once and never to keywords, blocked or
// opted-out contacts (FR-035, FR-036, SC-004, research R10).
describe('Live chat: automatic messages (US6)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let admin: SignedInAgent;
  let base: Record<string, unknown>;
  const ALWAYS = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [['00:00', '23:59']]]));
  const NEVER = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, []]));

  const settings = async (patch: Record<string, unknown>) => {
    const res = await admin.agent.put('/api/live-chat/settings').set('X-CSRF-Token', admin.csrf).send({ ...base, ...patch });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  };
  const inbound = async (phone: string, text: string, wamid = `wamid.in.${randomUUID()}`) => {
    const payload = webhook.inbound(number.phoneNumberId, phone.slice(1), text);
    (payload.entry[0]!.changes[0]!.value.messages[0] as { id: string }).id = wamid;
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return wamid;
  };
  const automatic = async (phone: string) =>
    ctx.prisma.chatMessage.findMany({ where: { origin: 'AUTOMATIC', conversation: { contact: { phoneE164: phone } } }, include: { message: true }, orderBy: { occurredAt: 'asc' } });

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    base = (await admin.agent.get('/api/live-chat/settings')).body as Record<string, unknown>;
    base = { ...base, timezone: 'UTC', humanKeywords: ['AGENT'], welcomeEnabled: false, welcomeContent: null, offHoursEnabled: false, offHoursContent: null, autoResolve: false };
  });

  afterAll(async () => {
    await admin.agent.put('/api/live-chat/settings').set('X-CSRF-Token', admin.csrf).send(base);
    await ctx.close();
  });

  it('welcomes a new conversation once, through the reply queue, labelled automatic', async () => {
    await settings({ workingHours: ALWAYS, welcomeEnabled: true, welcomeContent: { kind: 'TEXT', text: 'Welcome! A team member will answer soon.' } });
    const phone = uaePhone();
    const wamid = await inbound(phone, 'hello');
    await inbound(phone, 'hello', wamid); // the same webhook again
    await inbound(phone, 'are you there?'); // same opening

    const sent = await automatic(phone);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'SESSION_OUT', origin: 'AUTOMATIC', contentType: 'TEXT', text: 'Welcome! A team member will answer soon.', status: 'QUEUED', sentByUserId: null });
    expect(await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`session-${sent[0]!.id}`)).toBeTruthy();
    const opening = await ctx.prisma.conversationOpening.findFirstOrThrow({ where: { conversation: { contact: { phoneE164: phone } } } });
    expect(opening.welcomeSentAt).not.toBeNull();
    expect(opening.firstHumanReplyAt).toBeNull(); // automatic messages are not a member's response
  });

  it('answers outside working hours at most once per contact every 12 hours', async () => {
    await settings({ workingHours: NEVER, offHoursEnabled: true, offHoursContent: { kind: 'TEXT', text: 'We are closed now.' } });
    const phone = uaePhone();
    await inbound(phone, 'hi');
    await inbound(phone, 'hello?');
    expect((await automatic(phone)).map((m) => m.text)).toEqual(['We are closed now.']);
  });

  it('never replies to keywords, blocked contacts or opted-out contacts', async () => {
    await settings({ workingHours: NEVER, offHoursEnabled: true, offHoursContent: { kind: 'TEXT', text: 'We are closed now.' } });
    const stopper = uaePhone();
    await inbound(stopper, 'STOP');
    const asker = uaePhone();
    await inbound(asker, 'agent');
    const optedOut = uaePhone();
    await seedContact(ctx, optedOut, { consentStatus: 'OPTED_OUT', consentSource: 'KEYWORD' });
    await inbound(optedOut, 'hello');
    const blocked = uaePhone();
    const contact = await seedContact(ctx, blocked);
    await ctx.prisma.contact.update({ where: { id: contact.id }, data: { blockedAt: new Date() } });
    await inbound(blocked, 'hello');
    for (const phone of [stopper, asker, optedOut, blocked]) expect(await automatic(phone)).toHaveLength(0);
  });

  it('sends template content through the template path with variable fallbacks', async () => {
    const template = await seedTemplate(ctx, number.wabaId, { name: `welcome_${randomUUID().slice(0, 8).replace(/-/g, '')}` });
    await settings({
      workingHours: ALWAYS,
      welcomeEnabled: true,
      welcomeContent: { kind: 'TEMPLATE', templateId: template.id, variables: { 'BODY.1': { source: 'field', key: 'name', fallback: 'there' } } },
    });
    const phone = uaePhone();
    await inbound(phone, 'hi'); // no profile name, so the fallback is used
    const [ref] = await automatic(phone);
    expect(ref).toMatchObject({ kind: 'MESSAGE_REF', origin: 'AUTOMATIC', contentType: 'TEMPLATE' });
    expect(ref!.message).toMatchObject({ origin: 'INBOX', automatic: true, sentByUserId: null, status: 'QUEUED', resolvedParams: { 'BODY.1': 'there' } });
    expect(await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`msg-${ref!.messageId}`)).toBeTruthy();
  });

  it('sends an image from the media library', async () => {
    const upload = await admin.agent
      .post('/api/media-library')
      .set('X-CSRF-Token', admin.csrf)
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'closed.jpg', contentType: 'image/jpeg' });
    expect(upload.status).toBe(201);
    await settings({ workingHours: NEVER, offHoursEnabled: true, offHoursContent: { kind: 'IMAGE', mediaAssetId: upload.body.id, text: 'Our hours' } });
    const phone = uaePhone();
    await inbound(phone, 'hi');
    expect(await automatic(phone)).toMatchObject([{ kind: 'SESSION_OUT', contentType: 'IMAGE', mediaAssetId: upload.body.id, text: 'Our hours' }]);
  });

  it('refuses content that cannot be sent', async () => {
    const pending = await seedTemplate(ctx, number.wabaId, { status: 'PENDING' });
    const res = await admin.agent
      .put('/api/live-chat/settings')
      .set('X-CSRF-Token', admin.csrf)
      .send({ ...base, workingHours: ALWAYS, welcomeEnabled: true, welcomeContent: { kind: 'TEMPLATE', templateId: pending.id, variables: {} } });
    expect(res.status).toBe(422);
    expect(res.body.details).toContainEqual({ field: 'welcomeContent.templateId', issue: 'is pending, not approved' });
    const missingContent = await admin.agent.put('/api/live-chat/settings').set('X-CSRF-Token', admin.csrf).send({ ...base, welcomeEnabled: true, welcomeContent: null });
    expect(missingContent.status).toBe(422);
  });
});
