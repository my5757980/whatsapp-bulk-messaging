import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { StorageService } from '../../src/common/storage/storage.service.js';
import { seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T080: deleting a contact's personal data keeps aggregates (FR-015, Principle III).
describe('Contact deletion', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
  });
  afterAll(async () => ctx.close());

  it('removes personal data and consent history but keeps message outcomes and totals', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const phone = uaePhone();
    const target = await seedContact(ctx, phone, { name: 'Delete Me', attributes: { city: 'Dubai' } });
    const other = await seedContact(ctx, uaePhone());
    const tag = await ctx.prisma.tag.create({ data: { name: `vip-${target.id.slice(-6)}` } });
    await ctx.prisma.contactTag.create({ data: { contactId: target.id, tagId: tag.id } });
    await ctx.prisma.consentEvent.create({ data: { contactId: target.id, status: 'OPTED_IN', source: 'MANUAL', note: 'in store' } });

    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [target, other] });
    await ctx.prisma.campaignUploadRow.create({ data: { campaignId: campaign.id, rowNumber: 1, phoneE164: phone, data: { phone, name: 'Delete Me' } } });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id, contactId: target.id }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
    await ctx.prisma.message.updateMany({ where: { campaignId: campaign.id, contactId: other.id }, data: { status: 'READ', readAt: new Date() } });
    await ctx.prisma.campaign.update({ where: { id: campaign.id }, data: { state: 'COMPLETED', completedAt: new Date() } });
    const before = (await admin.agent.get(`/api/campaigns/${campaign.id}`)).body.totals;

    const res = await admin.agent.delete(`/api/contacts/${target.id}`).set('x-csrf-token', admin.csrf);
    expect(res.status).toBe(204);

    expect(await ctx.prisma.contact.findUnique({ where: { id: target.id } })).toBeNull();
    expect(await ctx.prisma.consentEvent.count({ where: { contactId: target.id } })).toBe(0);
    expect(await ctx.prisma.contactTag.count({ where: { contactId: target.id } })).toBe(0);
    expect(await ctx.prisma.campaignUploadRow.count({ where: { phoneE164: phone } })).toBe(0);

    const anonymised = await ctx.prisma.message.findMany({ where: { campaignId: campaign.id, contactId: null } });
    expect(anonymised).toHaveLength(1);
    expect(anonymised[0]).toMatchObject({ phoneE164: null, status: 'DELIVERED', recipientCountry: 'AE' });

    const after = (await admin.agent.get(`/api/campaigns/${campaign.id}`)).body.totals;
    expect(after).toEqual(before);
    expect(after).toMatchObject({ delivered: 1, read: 1 });

    const audit = await ctx.prisma.auditLog.findFirstOrThrow({ where: { action: 'contact.deleted', targetId: target.id } });
    expect(JSON.stringify(audit.metadata)).not.toContain(phone.slice(-7));
  });

  it('erases chat text, payloads and customer media but keeps chats and openings (002 FR-042)', async () => {
    const storage = ctx.app.get(StorageService);
    const number = await seedNumber(ctx);
    const contact = await seedContact(ctx, uaePhone(), { name: 'Chat Person' });
    const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id, lastMessagePreview: 'My address is 12 Palm St' } });
    const customerKey = `inbound/erase-${randomUUID()}.jpg`;
    const libraryKey = `library/erase-${randomUUID()}.jpg`;
    await storage.put(customerKey, Buffer.from('jpeg'), 'image/jpeg');
    await storage.put(libraryKey, Buffer.from('jpeg'), 'image/jpeg');
    const customerMedia = await ctx.prisma.mediaAsset.create({ data: { storageKey: customerKey, mimeType: 'image/jpeg', sizeBytes: 4, purpose: 'INBOUND' } });
    const libraryMedia = await ctx.prisma.mediaAsset.create({ data: { storageKey: libraryKey, mimeType: 'image/jpeg', sizeBytes: 4, purpose: 'LIBRARY', uploadedById: admin.userId } });
    const now = new Date();
    await ctx.prisma.chatMessage.createMany({
      data: [
        { conversationId: chat.id, kind: 'INBOUND', origin: 'CUSTOMER', contentType: 'IMAGE', text: 'my passport', mediaAssetId: customerMedia.id, payload: { mimeType: 'image/jpeg' }, occurredAt: now },
        { conversationId: chat.id, kind: 'SESSION_OUT', origin: 'MEMBER', contentType: 'IMAGE', text: 'our menu', mediaAssetId: libraryMedia.id, status: 'SENT', occurredAt: now },
        { conversationId: chat.id, kind: 'NOTE', origin: 'MEMBER', contentType: 'TEXT', text: 'VIP, lives at Palm St', payload: { mentions: [] }, occurredAt: now },
      ],
    });
    await ctx.prisma.conversationEvent.create({ data: { conversationId: chat.id, type: 'ATTRIBUTE_CHANGED', actorType: 'MEMBER', data: { key: 'city', to: 'Dubai Marina' } } });
    const opening = await ctx.prisma.conversationOpening.create({ data: { conversationId: chat.id, openedAt: now } });
    await ctx.prisma.notification.create({ data: { userId: admin.userId, type: 'INBOX_REQUESTING', title: 'Waiting for an agent', body: 'Chat Person asked to talk to a person', link: `/inbox?c=${chat.id}` } });

    expect((await admin.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);

    expect(await ctx.prisma.conversation.findUniqueOrThrow({ where: { id: chat.id } })).toMatchObject({ contactId: null, lastMessagePreview: null });
    const items = await ctx.prisma.chatMessage.findMany({ where: { conversationId: chat.id } });
    expect(items).toHaveLength(3);
    for (const item of items) expect(item).toMatchObject({ text: null, payload: {}, mediaAssetId: null });
    expect(items.find((i) => i.kind === 'SESSION_OUT')?.status).toBe('SENT');
    expect(await ctx.prisma.mediaAsset.findUnique({ where: { id: customerMedia.id } })).toBeNull();
    await expect(storage.getBuffer(customerKey)).rejects.toThrow();
    expect(await ctx.prisma.mediaAsset.findUnique({ where: { id: libraryMedia.id } })).not.toBeNull();
    const event = await ctx.prisma.conversationEvent.findFirstOrThrow({ where: { conversationId: chat.id, type: 'ATTRIBUTE_CHANGED' } });
    expect(event.data).toEqual({ key: 'city' });
    expect(await ctx.prisma.notification.count({ where: { link: `/inbox?c=${chat.id}` } })).toBe(0);
    expect(await ctx.prisma.conversationOpening.findUnique({ where: { id: opening.id } })).not.toBeNull();
  });

  it('clears chatbot flow answers and the contact link of its sessions (003)', async () => {
    const number = await seedNumber(ctx);
    const contact = await seedContact(ctx, uaePhone());
    const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id } });
    const flow = await ctx.prisma.flow.create({ data: { name: `Erasure flow ${randomUUID().slice(0, 6)}`, draft: { version: 1, start: null, triggers: [], steps: [] } } });
    const session = await ctx.prisma.flowSession.create({
      data: { flowId: flow.id, conversationId: chat.id, contactId: contact.id, numberId: number.id, startedBy: 'TRIGGER', status: 'ENDED', result: 'COMPLETED', answers: { email: 'sara@example.com' }, endedAt: new Date() },
    });
    expect((await admin.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);
    expect(await ctx.prisma.flowSession.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ contactId: null, answers: {} });
  });

  it("erases the contact's AI records but keeps reply counts and sources (004 FR-051)", async () => {
    const number = await seedNumber(ctx);
    const [contact, other] = await Promise.all([seedContact(ctx, uaePhone()), seedContact(ctx, uaePhone())]);
    const chat = await ctx.prisma.conversation.create({ data: { contactId: contact.id, numberId: number.id } });
    const otherChat = await ctx.prisma.conversation.create({ data: { contactId: other.id, numberId: number.id } });
    const agent = await ctx.prisma.aiAgent.create({ data: { name: `Erasure agent ${randomUUID().slice(0, 6)}`, draft: {} } });
    const conversation = await ctx.prisma.aiConversation.create({
      data: {
        conversationId: chat.id,
        agentId: agent.id,
        contactId: contact.id,
        numberId: number.id,
        startedBy: 'CUSTOMER',
        summary: 'Sara asked to cancel order 10234',
        pendingConfirmation: { skillId: 'cancel_order', input: { order_number: '10234' } },
        unansweredStreak: { count: 1 },
      },
    });
    const reply = await ctx.prisma.aiReply.create({
      data: { aiConversationId: conversation.id, agentId: agent.id, kind: 'REPLY', modelId: 'claude-opus-5-5', counted: true, sources: [{ id: 'k1', kind: 'ANSWER', title: 'Refunds' }] },
    });
    const otherConversation = await ctx.prisma.aiConversation.create({ data: { conversationId: otherChat.id, agentId: agent.id, contactId: other.id, numberId: number.id, startedBy: 'CUSTOMER' } });
    const shared = await ctx.prisma.aiUnansweredQuestion.create({ data: { agentId: agent.id, text: 'Do you ship to Oman?', normalized: `ship oman ${randomUUID()}`, askCount: 2 } });
    const onlyTheirs = await ctx.prisma.aiUnansweredQuestion.create({ data: { agentId: agent.id, text: 'Where is order 10234 for Sara?', normalized: `order sara ${randomUUID()}`, askCount: 1 } });
    await ctx.prisma.aiUnansweredAsk.createMany({
      data: [
        { questionId: shared.id, aiConversationId: conversation.id },
        { questionId: shared.id, aiConversationId: otherConversation.id },
        { questionId: onlyTheirs.id, aiConversationId: conversation.id },
      ],
    });

    expect((await admin.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);
    expect(await ctx.prisma.aiConversation.findUniqueOrThrow({ where: { id: conversation.id } })).toMatchObject({ contactId: null, summary: null, pendingConfirmation: null, unansweredStreak: null });
    expect(await ctx.prisma.aiReply.findUniqueOrThrow({ where: { id: reply.id } })).toMatchObject({ counted: true, sources: [{ id: 'k1', kind: 'ANSWER', title: 'Refunds' }] });
    // Their unanswered asks go; a question only they asked goes too, and shared counts follow.
    expect(await ctx.prisma.aiUnansweredAsk.count({ where: { aiConversationId: conversation.id } })).toBe(0);
    expect(await ctx.prisma.aiUnansweredQuestion.findUniqueOrThrow({ where: { id: shared.id } })).toMatchObject({ askCount: 1 });
    expect(await ctx.prisma.aiUnansweredQuestion.findUnique({ where: { id: onlyTheirs.id } })).toBeNull();
    // Another customer's AI records are untouched.
    expect(await ctx.prisma.aiConversation.findUniqueOrThrow({ where: { id: otherConversation.id } })).toMatchObject({ contactId: other.id });
    expect(await ctx.prisma.aiUnansweredAsk.count({ where: { aiConversationId: otherConversation.id } })).toBe(1);
  });

  it('is admin-only and returns 404 for unknown contacts', async () => {
    const contact = await seedContact(ctx, uaePhone());
    const manager = await signIn(ctx, 'MANAGER');
    expect((await manager.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', manager.csrf)).status).toBe(403);
    expect((await admin.agent.delete('/api/contacts/0190a000-0000-7000-8000-000000000000').set('x-csrf-token', admin.csrf)).status).toBe(404);
  });
});
