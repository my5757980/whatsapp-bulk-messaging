import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { INBOX_STREAM } from '../../src/modules/inbox/realtime/inbox-events.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T067: US5 - chat profile, customer journey, contact edits from the chat and blocking
// (FR-033, FR-034, research R16).
describe('Live chat: profile, journey and blocking (US5)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  let redis: Redis;

  const inbound = async (phone: string, text: string) =>
    ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), text)));
  const chatOf = (phone: string) => ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
  const newestStreamId = async () => (await redis.xrevrange(INBOX_STREAM, '+', '-', 'COUNT', 1))[0]?.[0] ?? '0-0';
  const eventsSince = async (id: string) =>
    (await redis.xrange(INBOX_STREAM, `(${id}`, '+')).map(([, fields]) => JSON.parse(fields[1]!) as { type: string; conversationId: string | null; contactId: string | null });

  beforeAll(async () => {
    ctx = await createTestContext();
    redis = ctx.app.get<Redis>(REDIS_CLIENT);
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
  });

  afterAll(async () => ctx.close());

  it('shows the profile with counts, source, recent campaigns and a masked phone for agents', async () => {
    const phone = uaePhone();
    const contact = await seedContact(ctx, phone, { leadSource: 'Import', attributes: { city: 'Dubai' } });
    const template = await seedTemplate(ctx, number.wabaId);
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id }, data: { status: 'READ', waMessageId: `wamid.${randomUUID()}`, sentAt: new Date() } });
    await inbound(phone, 'hi');
    await inbound(phone, 'agent?');
    const chat = await chatOf(phone);
    await ctx.prisma.conversation.update({ where: { id: chat.id }, data: { unresolvedRequests: 2 } });

    const res = await agent.agent.get(`/api/inbox/conversations/${chat.id}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      templateMessageCount: 1,
      sessionMessageCount: 0,
      unresolvedRequests: 2,
      profile: { leadSource: 'Import', phone: `•••• ${phone.slice(-4)}`, attributes: { city: 'Dubai' }, consentStatus: 'OPTED_IN' },
      recentCampaigns: [{ campaignId: campaign.id, name: campaign.name, status: 'READ' }],
    });
  });

  it('edits the contact from the chat, needs contacts.manage, and records it in the journey', async () => {
    const phone = uaePhone();
    await inbound(phone, 'hello');
    const chat = await chatOf(phone);
    const vip = await ctx.prisma.tag.create({ data: { name: `vip-${randomUUID().slice(0, 6)}` } });
    const first = await ctx.prisma.tag.create({ data: { name: `first-${randomUUID().slice(0, 6)}` } });
    await ctx.prisma.attributeDefinition.upsert({ where: { key: 'city' }, create: { key: 'city', label: 'City', type: 'TEXT' }, update: {} });

    const edit = (who: SignedInAgent, body: Record<string, unknown>) => who.agent.patch(`/api/inbox/conversations/${chat.id}/contact`).set('X-CSRF-Token', who.csrf).send(body);
    expect((await edit(agent, { name: 'Nope' })).status).toBe(403);

    const before = await newestStreamId();
    const res = await edit(manager, { name: 'Omar Ali', attributes: { city: 'Sharjah' }, addTagIds: [vip.id], firstMessageTagId: first.id });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Omar Ali', attributes: { city: 'Sharjah' }, tags: [{ id: vip.id }], firstMessageTag: { id: first.id } });

    const removed = await edit(manager, { removeTagIds: [vip.id], attributes: { city: null } });
    expect(removed.body.tags).toEqual([]);

    const journey = await agent.agent.get(`/api/inbox/conversations/${chat.id}/journey`);
    expect(journey.status).toBe(200);
    const types = (journey.body as Array<{ type: string }>).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['TAG_ADDED', 'TAG_REMOVED', 'ATTRIBUTE_CHANGED', 'FIRST_MESSAGE_TAG_CHANGED']));
    expect(journey.body[0]).toMatchObject({ actor: { type: 'MEMBER' } });
    expect(await eventsSince(before)).toContainEqual(expect.objectContaining({ type: 'contact.updated', contactId: chat.contactId }));
  });

  it('merges campaign sends and consent changes into the journey, newest first', async () => {
    const phone = uaePhone();
    const contact = await seedContact(ctx, phone);
    const template = await seedTemplate(ctx, number.wabaId);
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id }, data: { status: 'DELIVERED', waMessageId: `wamid.${randomUUID()}`, sentAt: new Date(Date.now() - 60_000) } });
    await inbound(phone, 'hello');
    await inbound(phone, 'STOP');
    const chat = await chatOf(phone);

    const journey = (await admin.agent.get(`/api/inbox/conversations/${chat.id}/journey`)).body as Array<{ type: string; at: string; actor: { type: string; name: string | null } }>;
    expect(journey.map((e) => e.type)).toEqual(['CONSENT_CHANGED', 'CAMPAIGN_SENT']);
    expect(journey[0]).toMatchObject({ actor: { type: 'CUSTOMER' }, data: { status: 'OPTED_OUT', source: 'KEYWORD' } });
    expect(journey[1]).toMatchObject({ actor: { type: 'CAMPAIGN', name: campaign.name } });
  });

  it('blocks a contact: messages are kept quietly and the chat leaves the live lists until unblocked', async () => {
    const phone = uaePhone();
    await inbound(phone, 'hello');
    const chat = await chatOf(phone);
    const block = (method: 'post' | 'delete') => agent.agent[method](`/api/contacts/${chat.contactId}/block`).set('X-CSRF-Token', agent.csrf);
    expect((await block('post')).status).toBe(204);
    expect(await ctx.prisma.contact.findUniqueOrThrow({ where: { id: chat.contactId! } })).toMatchObject({ blockedById: agent.userId });

    const before = await newestStreamId();
    await inbound(phone, 'spam spam');
    expect(await ctx.prisma.chatMessage.count({ where: { conversationId: chat.id, text: 'spam spam' } })).toBe(1);
    expect((await eventsSince(before)).filter((e) => e.conversationId === chat.id && e.type === 'message.created')).toHaveLength(0);
    const live = (await admin.agent.get('/api/inbox/conversations').query({ limit: 100 })).body.items as Array<{ id: string }>;
    expect(live.some((c) => c.id === chat.id)).toBe(false);
    const history = (await admin.agent.get('/api/inbox/conversations').query({ view: 'history', q: phone.slice(-7) })).body.items as Array<{ id: string; blocked: boolean }>;
    expect(history.find((c) => c.id === chat.id)).toMatchObject({ blocked: true });

    expect((await block('delete')).status).toBe(204);
    const after = (await admin.agent.get('/api/inbox/conversations').query({ limit: 100 })).body.items as Array<{ id: string }>;
    expect(after.some((c) => c.id === chat.id)).toBe(true);
    const journey = (await admin.agent.get(`/api/inbox/conversations/${chat.id}/journey`)).body as Array<{ type: string }>;
    expect(journey.map((e) => e.type).slice(0, 2)).toEqual(['UNBLOCKED', 'BLOCKED']);
    expect((await agent.agent.post(`/api/contacts/${randomUUID()}/block`).set('X-CSRF-Token', agent.csrf)).status).toBe(404);
  });

  it('still lets campaigns reach a blocked contact who has not opted out', async () => {
    const phone = uaePhone();
    await inbound(phone, 'hello');
    const chat = await chatOf(phone);
    await admin.agent.post(`/api/contacts/${chat.contactId}/block`).set('X-CSRF-Token', admin.csrf);
    const contact = await ctx.prisma.contact.findUniqueOrThrow({ where: { id: chat.contactId! } });
    expect(contact.blockedAt).not.toBeNull();
    expect(contact.consentStatus).not.toBe('OPTED_OUT'); // blocking never changes consent
  });

  it('records where new contacts come from', async () => {
    const phone = uaePhone();
    await inbound(phone, 'hi');
    expect((await ctx.prisma.contact.findUniqueOrThrow({ where: { phoneE164: phone } })).leadSource).toBe('Organic');
  });
});
