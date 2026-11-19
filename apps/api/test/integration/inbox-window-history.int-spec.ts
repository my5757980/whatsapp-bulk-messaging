import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { QueueRegistry, REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { INBOX_STREAM } from '../../src/modules/inbox/realtime/inbox-events.service.js';
import { WINDOW_CLOSE_LAST_RUN_KEY, WindowCloseProcessor } from '../../src/modules/inbox/routing/window-close.processor.js';
import { SessionSendProcessor } from '../../src/modules/inbox/messages/session-send.processor.js';
import { SendProcessor } from '../../src/modules/sending/send.processor.js';
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

// T037: US2 - the 24-hour window, Past chats and restarting with a template (FR-006-FR-009,
// FR-013-FR-018, research R5, R12).
describe('Live chat: window, Past chats and templates (US2)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  const HOUR = 3_600_000;

  const inbound = async (phone: string, text: string) =>
    ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), text)));
  const chatOf = (phone: string) => ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
  /** A chat whose customer last wrote `hoursAgo` hours ago. */
  const chatAged = async (hoursAgo: number, state: 'ACTIVE' | 'INTERVENED' = 'ACTIVE', ownerId: string | null = null) => {
    const phone = uaePhone();
    await inbound(phone, 'hello');
    const chat = await chatOf(phone);
    const at = new Date(Date.now() - hoursAgo * HOUR);
    await ctx.prisma.conversation.update({
      where: { id: chat.id },
      data: { lastCustomerMessageAt: at, lastInboundAt: at, lastActivityAt: at, state, intervenedById: ownerId, intervenedAt: ownerId ? at : null },
    });
    return { phone, chat };
  };
  const post = (who: SignedInAgent, path: string) => who.agent.post(path).set('X-CSRF-Token', who.csrf);

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('shows when the reply window closes', async () => {
    const phone = uaePhone();
    await inbound(phone, 'hi');
    const chat = await chatOf(phone);
    const res = await agent.agent.get(`/api/inbox/conversations/${chat.id}`);
    expect(res.body.windowEndsAt).toBe(new Date(chat.lastCustomerMessageAt!.getTime() + 24 * HOUR).toISOString());
    expect(res.body).toMatchObject({ inHistory: false, canReply: true });
  });

  it('lists chats past 24 hours under Past chats only', async () => {
    const { chat: live } = await chatAged(23);
    const { chat: past } = await chatAged(25);
    const ids = async (view: string) => ((await admin.agent.get('/api/inbox/conversations').query({ view, limit: 100 })).body.items as Array<{ id: string }>).map((c) => c.id);
    expect(await ids('history')).toContain(past.id);
    expect(await ids('history')).not.toContain(live.id);
    expect(await ids('live')).toContain(live.id);
    expect(await ids('live')).not.toContain(past.id);
    const detail = await admin.agent.get(`/api/inbox/conversations/${past.id}`);
    expect(detail.body).toMatchObject({ inHistory: true, canReply: false });
  });

  it('refuses a free reply after 24 hours', async () => {
    const { chat } = await chatAged(25);
    const res = await post(agent, `/api/inbox/conversations/${chat.id}/messages`).send({ type: 'text', text: 'Sorry for the wait' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('WINDOW_CLOSED');
    expect(await ctx.prisma.chatMessage.count({ where: { conversationId: chat.id, kind: 'SESSION_OUT' } })).toBe(0);
  });

  it('does not send a reply that was queued just before the window closed', async () => {
    const { chat } = await chatAged(23);
    const queued = await post(agent, `/api/inbox/conversations/${chat.id}/messages`).send({ type: 'text', text: 'Just in time?' });
    expect(queued.status).toBe(202);
    // The sender runs one second after the 24-hour mark.
    await ctx.prisma.conversation.update({ where: { id: chat.id }, data: { lastCustomerMessageAt: new Date(Date.now() - 24 * HOUR - 1_000) } });
    expect(await ctx.app.get(SessionSendProcessor).process(queued.body.id as string, 1)).toMatchObject({ result: 'failed' });
    const item = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: queued.body.id as string } });
    expect(item).toMatchObject({ status: 'FAILED', waMessageId: null });
    expect(item.failureReason).toMatch(/24-hour/);
  });

  it('restarts a past chat with a template and shows its ticks', async () => {
    const { phone, chat } = await chatAged(30);
    const template = await seedTemplate(ctx, number.wabaId, { name: `order_${randomUUID().slice(0, 8).replace(/-/g, '')}` });

    const res = await post(agent, `/api/inbox/conversations/${chat.id}/template`).send({ templateId: template.id, params: { 'BODY.1': 'Sara' } });
    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      kind: 'MESSAGE_REF',
      origin: 'MEMBER',
      contentType: 'TEMPLATE',
      status: 'QUEUED',
      sentBy: { id: agent.userId },
      template: { name: template.name, renderedText: 'Hi Sara, your order is ready.' },
    });
    const ref = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: res.body.id as string }, include: { message: true } });
    expect(ref.message).toMatchObject({ origin: 'INBOX', sentByUserId: agent.userId, status: 'QUEUED', automatic: false });
    const job = await ctx.app.get(QueueRegistry).sendQueue(number.id).getJob(`msg-${ref.messageId}`);
    expect(job?.opts.priority).toBe(1);

    const wamid = `wamid.out.${randomUUID()}`;
    nock(META_BASE).post(`/${META_VERSION}/${number.phoneNumberId}/messages`).reply(200, { messages: [{ id: wamid }] });
    expect(await ctx.app.get(SendProcessor).process(ref.messageId!, 1)).toMatchObject({ result: 'sent' });
    for (const status of ['delivered', 'read']) {
      await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.status(number.phoneNumberId, wamid, phone.slice(1), status)));
    }
    const items = await agent.agent.get(`/api/inbox/conversations/${chat.id}/items`);
    expect(items.body.items[0]).toMatchObject({ id: res.body.id, status: 'READ' });
    // The chat moved up the list, still in Past chats until the customer answers.
    const after = await agent.agent.get(`/api/inbox/conversations/${chat.id}`);
    expect(after.body).toMatchObject({ inHistory: true, lastMessagePreview: `Template: ${template.name}` });
  });

  it('refuses templates the contact may not receive', async () => {
    const optedOut = uaePhone();
    await seedContact(ctx, optedOut, { consentStatus: 'OPTED_OUT', consentSource: 'KEYWORD' });
    await inbound(optedOut, 'thanks');
    const utility = await seedTemplate(ctx, number.wabaId);
    const marketing = await seedTemplate(ctx, number.wabaId, { category: 'MARKETING' });
    const pending = await seedTemplate(ctx, number.wabaId, { status: 'PENDING' });
    const out = await chatOf(optedOut);
    const send = (chatId: string, templateId: string, params: Record<string, string> = { 'BODY.1': 'Sara' }) =>
      post(admin, `/api/inbox/conversations/${chatId}/template`).send({ templateId, params });

    expect((await send(out.id, utility.id)).body.code).toBe('CONTACT_OPTED_OUT');

    const unknown = uaePhone();
    await inbound(unknown, 'hi'); // a new contact with consent UNKNOWN
    const chat = await chatOf(unknown);
    const noOptIn = await send(chat.id, marketing.id);
    expect(noOptIn.status).toBe(422);
    expect(noOptIn.body.code).toBe('NO_OPT_IN');
    expect((await send(chat.id, pending.id)).body.code).toBe('TEMPLATE_NOT_APPROVED');
    const missing = await send(chat.id, utility.id, {});
    expect(missing.body).toMatchObject({ code: 'PARAMS_MISMATCH', details: [{ field: 'params.BODY.1', issue: 'is required' }] });
    expect(await ctx.prisma.message.count({ where: { contact: { phoneE164: { in: [optedOut, unknown] } } } })).toBe(0);
  });

  it('brings a past chat back to live when the customer writes, keeping its owner', async () => {
    const { phone, chat } = await chatAged(30, 'INTERVENED', agent.userId);
    await inbound(phone, 'I am back');
    const after = await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } });
    expect(after).toMatchObject({ state: 'INTERVENED', intervenedById: agent.userId });
    expect((await agent.agent.get(`/api/inbox/conversations/${chat.id}`)).body).toMatchObject({ inHistory: false, canReply: true });
    expect(await ctx.prisma.conversationOpening.count({ where: { conversationId: chat.id } })).toBe(2);
  });

  it('tells open screens within a minute when a window closes', async () => {
    const { chat } = await chatAged(24 + 10 / 3_600); // the 24-hour mark passed 10 s ago
    const redis = ctx.app.get<Redis>(REDIS_CLIENT);
    const [newest] = await redis.xrevrange(INBOX_STREAM, '+', '-', 'COUNT', 1);
    await redis.del(WINDOW_CLOSE_LAST_RUN_KEY); // look back one minute, whatever ran before
    await ctx.app.get(WindowCloseProcessor).run();
    const entries = await redis.xrange(INBOX_STREAM, newest ? `(${newest[0]}` : '-', '+');
    const events = entries.map(([, fields]) => JSON.parse(fields[1]!) as { type: string; conversationId: string });
    expect(events).toContainEqual(expect.objectContaining({ type: 'conversation.window_closed', conversationId: chat.id }));
  });

  it('opens or creates the chat with a contact, with earlier campaign messages', async () => {
    const phone = uaePhone();
    const contact = await seedContact(ctx, phone);
    const template = await seedTemplate(ctx, number.wabaId);
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id }, data: { status: 'DELIVERED', waMessageId: `wamid.${randomUUID()}`, sentAt: new Date() } });

    const created = await post(agent, '/api/inbox/conversations').send({ contactId: contact.id, numberId: number.id });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ contactId: contact.id, numberId: number.id, state: 'ACTIVE', inHistory: true });
    const again = await post(agent, '/api/inbox/conversations').send({ contactId: contact.id, numberId: number.id });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(created.body.id);
    const items = await agent.agent.get(`/api/inbox/conversations/${created.body.id}/items`);
    expect(items.body.items).toMatchObject([{ kind: 'MESSAGE_REF', campaign: { id: campaign.id } }]);
    expect((await post(agent, '/api/inbox/conversations').send({ contactId: randomUUID(), numberId: number.id })).status).toBe(404);
  });
});
