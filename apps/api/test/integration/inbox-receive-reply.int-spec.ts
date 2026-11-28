import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { INBOX_QUEUE } from '../../src/modules/inbox/inbox-queue.js';
import { InboundMediaProcessor } from '../../src/modules/inbox/inbound/inbound-media.processor.js';
import { ReadReceiptProcessor } from '../../src/modules/inbox/messages/read-receipt.processor.js';
import { SessionSendProcessor } from '../../src/modules/inbox/messages/session-send.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import {
  META_BASE,
  META_VERSION,
  restoreNetwork,
  seedContact,
  seedNumber,
  seedRunningCampaign,
  seedTemplate,
  setDefaultCountry,
  uaePhone,
  useNockLocalOnly,
} from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T024: US1 - customers' messages appear in live chat; a member takes the chat, replies and closes
// it (spec US1, FR-001-FR-005, FR-010-FR-014, FR-019, FR-020, FR-023, R3, R4, R6, R8, R11).
describe('Live chat: receive and answer (US1)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string };
  let admin: SignedInAgent;
  let agentA: SignedInAgent;
  let agentB: SignedInAgent;

  /** Posts a signed inbound message of any type and runs the webhook processor. */
  async function inbound(phone: string, message: Record<string, unknown>, opts: { name?: string; wamid?: string } = {}): Promise<string> {
    const waId = phone.slice(1);
    const wamid = opts.wamid ?? `wamid.in.${randomUUID()}`;
    const payload = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: number.phoneNumberId },
                contacts: [{ wa_id: waId, profile: { name: opts.name ?? 'Sara Khan' } }],
                messages: [{ from: waId, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
              },
            },
          ],
        },
      ],
    };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    return wamid;
  }

  const text = (body: string) => ({ type: 'text', text: { body } });
  const chatOf = (phone: string) => ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
  const items = (conversationId: string) =>
    ctx.prisma.chatMessage.findMany({ where: { conversationId }, orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] });
  const statusWebhook = async (wamid: string, recipient: string, status: string, extra: Record<string, unknown> = {}) =>
    ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.status(number.phoneNumberId, wamid, recipient, status, extra)));

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    agentA = await signIn(ctx, 'AGENT');
    agentB = await signIn(ctx, 'AGENT');
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('creates the contact and an open chat from a first message', async () => {
    const phone = uaePhone();
    const wamid = await inbound(phone, text('Is the blue one available?'), { name: 'Sara Khan' });

    const contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } });
    expect(contact).toMatchObject({ name: 'Sara Khan', leadSourceKind: 'ORGANIC' });
    const chat = await chatOf(phone);
    expect(chat).toMatchObject({ numberId: number.id, state: 'ACTIVE', intervenedById: null, lastMessagePreview: 'Is the blue one available?' });
    expect(chat.lastCustomerMessageAt).not.toBeNull();
    expect(await ctx.prisma.conversationOpening.count({ where: { conversationId: chat.id } })).toBe(1);
    expect(await items(chat.id)).toMatchObject([
      { kind: 'INBOUND', origin: 'CUSTOMER', contentType: 'TEXT', text: 'Is the blue one available?', waMessageId: wamid },
    ]);

    const list = await admin.agent.get('/api/inbox/conversations').query({ view: 'live', state: 'ACTIVE' });
    expect(list.status).toBe(200);
    const row = (list.body.items as Array<Record<string, unknown>>).find((c) => c.id === chat.id);
    expect(row).toMatchObject({ contactName: 'Sara Khan', phone, state: 'ACTIVE', inHistory: false, unread: 1, blocked: false });
    expect(list.body.counts.ACTIVE).toBeGreaterThanOrEqual(1);

    // Agents see the same chat with the phone masked to its last 4 digits (FR-029).
    const forAgent = await agentA.agent.get(`/api/inbox/conversations/${chat.id}`);
    expect(forAgent.status).toBe(200);
    expect(forAgent.body.phone).toBe(`•••• ${phone.slice(-4)}`);
    expect(forAgent.body).toMatchObject({ canReply: true, windowEndsAt: expect.any(String) });
  });

  it('adds earlier campaign messages to the timeline of a new chat', async () => {
    const phone = uaePhone();
    const contact = await seedContact(ctx, phone);
    const template = await seedTemplate(ctx, 'WABA', { name: `promo_${randomUUID().slice(0, 8).replace(/-/g, '')}` });
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] });
    await ctx.prisma.message.updateMany({
      where: { campaignId: campaign.id },
      data: { status: 'READ', waMessageId: `wamid.out.${randomUUID()}`, sentAt: new Date(Date.now() - 3_600_000), readAt: new Date() },
    });

    await inbound(phone, text('Thanks for the offer'));
    const chat = await chatOf(phone);
    const res = await admin.agent.get(`/api/inbox/conversations/${chat.id}/items`);
    expect(res.status).toBe(200);
    const [newest, older] = res.body.items as Array<Record<string, unknown>>;
    expect(newest).toMatchObject({ kind: 'INBOUND', text: 'Thanks for the offer' });
    expect(older).toMatchObject({
      kind: 'MESSAGE_REF',
      origin: 'CAMPAIGN',
      contentType: 'TEMPLATE',
      status: 'READ',
      campaign: { id: campaign.id, name: campaign.name },
      template: { name: template.name, renderedText: 'Hi Friend, your order is ready.' },
    });
  });

  it('stores a repeated webhook only once', async () => {
    const phone = uaePhone();
    const wamid = `wamid.in.${randomUUID()}`;
    await inbound(phone, text('hello'), { wamid });
    await inbound(phone, text('hello'), { wamid });
    const chat = await chatOf(phone);
    expect(await items(chat.id)).toHaveLength(1);
    expect(await ctx.prisma.conversationOpening.count({ where: { conversationId: chat.id } })).toBe(1);
  });

  it('downloads a picture the customer sent and serves it to members', async () => {
    const phone = uaePhone();
    const mediaId = `media-${randomUUID()}`;
    await inbound(phone, { type: 'image', image: { id: mediaId, mime_type: 'image/jpeg', sha256: 'x', caption: 'this one' } });
    const chat = await chatOf(phone);
    const [item] = await items(chat.id);
    expect(item).toMatchObject({ contentType: 'IMAGE', text: 'this one', mediaState: 'PENDING', mediaAssetId: null });
    expect(await ctx.app.get(QueueRegistry).get(INBOX_QUEUE).getJob(`media-${item!.id}`)).toBeTruthy();

    nock(META_BASE)
      .get(`/${META_VERSION}/${mediaId}`)
      .reply(200, { messaging_product: 'whatsapp', url: `${META_BASE}/download/${mediaId}`, mime_type: 'image/jpeg', file_size: 4, id: mediaId });
    nock(META_BASE).get(`/download/${mediaId}`).matchHeader('authorization', 'Bearer number-access-token').reply(200, Buffer.from('jpeg'), { 'content-type': 'image/jpeg' });
    expect(await ctx.app.get(InboundMediaProcessor).process({ chatMessageId: item!.id, metaMediaId: mediaId }, 1)).toBe('ready');

    const stored = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: item!.id }, include: { mediaAsset: true } });
    expect(stored).toMatchObject({ mediaState: 'READY', mediaAsset: { purpose: 'INBOUND', mimeType: 'image/jpeg', sizeBytes: 4 } });
    const file = await agentA.agent.get(`/api/inbox/media/${stored.mediaAssetId}`).buffer(true);
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toContain('image/jpeg');
    expect(Buffer.from(file.body as Buffer).toString()).toBe('jpeg');
  });

  it('marks media unavailable after the last failed download', async () => {
    const phone = uaePhone();
    const mediaId = `media-${randomUUID()}`;
    await inbound(phone, { type: 'document', document: { id: mediaId, mime_type: 'application/pdf', filename: 'menu.pdf' } });
    const [item] = await items((await chatOf(phone)).id);
    nock(META_BASE).get(`/${META_VERSION}/${mediaId}`).times(2).reply(404, { error: { message: 'Unknown media', code: 100 } });
    expect(await ctx.app.get(InboundMediaProcessor).process({ chatMessageId: item!.id, metaMediaId: mediaId }, 1)).toBe('retry');
    expect(await ctx.app.get(InboundMediaProcessor).process({ chatMessageId: item!.id, metaMediaId: mediaId }, 3)).toBe('failed');
    expect(await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: item!.id } })).toMatchObject({ mediaState: 'FAILED' });
  });

  it('lets exactly one member take a chat', async () => {
    const phone = uaePhone();
    await inbound(phone, text('anyone there?'));
    const chat = await chatOf(phone);
    const responses = await Promise.all(
      [agentA, agentB].map((m) => m.agent.post(`/api/inbox/conversations/${chat.id}/intervene`).set('X-CSRF-Token', m.csrf)),
    );
    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(responses.find((r) => r.status === 409)!.body.code).toBe('ALREADY_TAKEN');
    const winner = responses[0]!.status === 200 ? agentA : agentB;
    expect(await chatOf(phone)).toMatchObject({ state: 'INTERVENED', intervenedById: winner.userId });
  });

  it('sends a text reply through the number queue and shows the ticks', async () => {
    const phone = uaePhone();
    await inbound(phone, text('Is it in stock?'));
    const chat = await chatOf(phone);

    const sent = await agentA.agent
      .post(`/api/inbox/conversations/${chat.id}/messages`)
      .set('X-CSRF-Token', agentA.csrf)
      .send({ type: 'text', text: 'Yes, it is!' });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ kind: 'SESSION_OUT', origin: 'MEMBER', contentType: 'TEXT', status: 'QUEUED', sentBy: { id: agentA.userId } });
    // Replying takes the chat automatically (FR-020).
    expect(await chatOf(phone)).toMatchObject({ state: 'INTERVENED', intervenedById: agentA.userId });

    const job = await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`session-${sent.body.id}`);
    expect(job).toMatchObject({ name: 'session', opts: expect.objectContaining({ priority: 1 }) });

    const wamid = `wamid.out.${randomUUID()}`;
    let graphBody: Record<string, unknown> | undefined;
    nock(META_BASE)
      .post(`/${META_VERSION}/${number.phoneNumberId}/messages`, (body: Record<string, unknown>) => {
        graphBody = body;
        return true;
      })
      .reply(200, { messaging_product: 'whatsapp', messages: [{ id: wamid }] });
    expect(await ctx.app.get(SessionSendProcessor).process(sent.body.id as string, 1)).toMatchObject({ result: 'sent' });
    expect(graphBody).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.slice(1),
      type: 'text',
      text: { body: 'Yes, it is!', preview_url: true },
    });

    for (const status of ['sent', 'delivered', 'read']) await statusWebhook(wamid, phone.slice(1), status, { pricing: { billable: false, category: 'service' } });
    const item = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: sent.body.id as string } });
    expect(item).toMatchObject({ status: 'READ', waMessageId: wamid });
    expect(item.deliveredAt).not.toBeNull();
    expect(item.readAt).not.toBeNull();
  });

  it('shows why a reply failed', async () => {
    const phone = uaePhone();
    await inbound(phone, text('hi'));
    const chat = await chatOf(phone);
    const sent = await agentA.agent.post(`/api/inbox/conversations/${chat.id}/messages`).set('X-CSRF-Token', agentA.csrf).send({ type: 'text', text: 'Hello' });
    const wamid = `wamid.out.${randomUUID()}`;
    nock(META_BASE).post(`/${META_VERSION}/${number.phoneNumberId}/messages`).reply(200, { messages: [{ id: wamid }] });
    await ctx.app.get(SessionSendProcessor).process(sent.body.id as string, 1);
    await statusWebhook(wamid, phone.slice(1), 'failed', { errors: [{ code: 131026, title: 'Message undeliverable' }] });

    const items = await admin.agent.get(`/api/inbox/conversations/${chat.id}/items`);
    expect(items.body.items[0]).toMatchObject({ id: sent.body.id, status: 'FAILED', failureReason: expect.stringContaining('undeliverable') });
  });

  it('refuses a second agent and lets the owner close the chat', async () => {
    const phone = uaePhone();
    await inbound(phone, text('need help'));
    const chat = await chatOf(phone);
    expect((await agentA.agent.post(`/api/inbox/conversations/${chat.id}/intervene`).set('X-CSRF-Token', agentA.csrf)).status).toBe(200);

    // Another agent can no longer see it, an admin still can (FR-026, FR-027).
    expect((await agentB.agent.get(`/api/inbox/conversations/${chat.id}`)).status).toBe(404);
    const agentList = await agentB.agent.get('/api/inbox/conversations');
    expect((agentList.body.items as Array<{ id: string }>).some((c) => c.id === chat.id)).toBe(false);
    expect((await admin.agent.get(`/api/inbox/conversations/${chat.id}`)).status).toBe(200);
    expect((await agentB.agent.post(`/api/inbox/conversations/${chat.id}/resolve`).set('X-CSRF-Token', agentB.csrf)).status).toBe(404);

    const resolved = await agentA.agent.post(`/api/inbox/conversations/${chat.id}/resolve`).set('X-CSRF-Token', agentA.csrf);
    expect(resolved.status).toBe(200);
    expect(resolved.body).toMatchObject({ id: chat.id, state: 'ACTIVE', intervenedBy: null });
    const journey = await ctx.prisma.conversationEvent.findMany({ where: { conversationId: chat.id }, orderBy: { occurredAt: 'asc' } });
    expect(journey.map((e) => e.type)).toEqual(['INTERVENED', 'RESOLVED']);
    expect((await ctx.prisma.conversationOpening.findFirstOrThrow({ where: { conversationId: chat.id } })).resolvedById).toBe(agentA.userId);
  });

  it('marks a chat read and sends one read receipt to WhatsApp', async () => {
    const phone = uaePhone();
    await inbound(phone, text('first'));
    const latest = await inbound(phone, text('second'));
    const chat = await chatOf(phone);

    const before = await admin.agent.get('/api/inbox/conversations').query({ q: phone.slice(-7) });
    expect((before.body.items as Array<{ id: string; unread: number }>).find((c) => c.id === chat.id)?.unread).toBe(2);
    const unreadBefore = (await admin.agent.get('/api/inbox/unread')).body.total as number;

    expect((await admin.agent.post(`/api/inbox/conversations/${chat.id}/read`).set('X-CSRF-Token', admin.csrf)).status).toBe(204);
    const after = await admin.agent.get('/api/inbox/conversations').query({ q: phone.slice(-7) });
    expect((after.body.items as Array<{ id: string; unread: number }>).find((c) => c.id === chat.id)?.unread).toBe(0);
    expect((await admin.agent.get('/api/inbox/unread')).body.total).toBe(unreadBefore - 1);

    let receipt: Record<string, unknown> | undefined;
    nock(META_BASE)
      .post(`/${META_VERSION}/${number.phoneNumberId}/messages`, (body: Record<string, unknown>) => {
        receipt = body;
        return true;
      })
      .reply(200, { success: true });
    await ctx.app.get(ReadReceiptProcessor).process(chat.id);
    expect(receipt).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: latest });
  });
});
