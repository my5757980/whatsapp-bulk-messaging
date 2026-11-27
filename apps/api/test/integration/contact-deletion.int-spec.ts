import { randomInt, randomUUID } from 'node:crypto';
import { makeChatRef, makeLinkCode } from '@wbm/shared';
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

  it('ends their drips and clears them from clicks, enrolments, tracked links and starting events (005 FR-040)', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const contact = await seedContact(ctx, uaePhone());
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] });
    const message = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: campaign.id, contactId: contact.id } });
    const target = await ctx.prisma.trackedLinkTarget.create({ data: { campaignId: campaign.id, variableKey: 'BODY.1', destination: 'https://shop.example/erase' } });
    const link = await ctx.prisma.trackedLink.create({ data: { code: `Er${randomUUID().replace(/-/g, '').slice(0, 8)}`, targetId: target.id, messageId: message.id, contactId: contact.id } });
    const click = await ctx.prisma.linkClick.create({ data: { trackedLinkId: link.id, targetId: target.id, campaignId: campaign.id, contactId: contact.id, device: 'MOBILE' } });
    const drip = await ctx.prisma.drip.create({ data: { name: `Erasure drip ${randomUUID().slice(0, 6)}`, numberId: number.id, status: 'ACTIVE' } });
    const enrolment = await ctx.prisma.dripEnrolment.create({ data: { dripId: drip.id, contactId: contact.id, joinedVia: 'MANUAL', nextDueAt: new Date() } });
    await ctx.prisma.dripEvent.create({ data: { kind: 'OPTED_IN', contactId: contact.id } });

    expect((await admin.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);
    expect(await ctx.prisma.trackedLink.findUniqueOrThrow({ where: { id: link.id } })).toMatchObject({ contactId: null });
    expect(await ctx.prisma.linkClick.findUniqueOrThrow({ where: { id: click.id } })).toMatchObject({ contactId: null, device: 'MOBILE' });
    expect(await ctx.prisma.dripEnrolment.findUniqueOrThrow({ where: { id: enrolment.id } })).toMatchObject({ contactId: null, status: 'LEFT', leftReason: 'DELETED', nextDueAt: null });
    expect(await ctx.prisma.dripEvent.count({ where: { contactId: contact.id } })).toBe(0);
  });

  it('stops their carts, closes COD questions, keeps calls, orders and chat starts without them, and cancels waiting webhooks (006 FR-060)', async () => {
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const phone = uaePhone();
    const contact = await seedContact(ctx, phone, { name: 'Order Person' });
    const store = await ctx.prisma.storeConnection.create({
      data: { platform: 'SHOPIFY', name: 'Erase shop', baseUrl: `https://${randomUUID()}.myshopify.com`, credentialsEncrypted: 'x', numberId: number.id, defaultCountry: 'AE', customerTag: 'shopify', status: 'DISCONNECTED' },
    });
    const now = new Date();
    const cart = await ctx.prisma.storeCart.create({
      data: { storeId: store.id, externalId: randomUUID(), contactId: contact.id, phoneE164: phone, value: '20.00', currency: 'AED', startedAt: now, storeUpdatedAt: now, status: 'REMINDING', nextStep: 2, nextAt: new Date(now.getTime() + 3_600_000) },
    });
    const order = await ctx.prisma.storeOrder.create({
      data: { storeId: store.id, externalId: randomUUID(), orderNumber: '#77', contactId: contact.id, phoneE164: phone, customerName: 'Order Person', total: '20.00', currency: 'AED', paymentKind: 'COD', status: 'pending', placedAt: now, storeUpdatedAt: now, codStatus: 'ASKED', codNextAt: new Date(now.getTime() + 3_600_000) },
    });
    const campaign = await ctx.prisma.apiCampaign.create({ data: { name: `Erase ${randomUUID()}`, apiName: `erase-${randomUUID().slice(0, 8)}`, numberId: number.id, templateId: template.id } });
    const trigger = await ctx.prisma.apiCampaignTrigger.create({ data: { apiCampaignId: campaign.id, contactId: contact.id, phoneE164: phone, outcome: 'NOT_SENT', reason: 'opted_out' } });
    const link = await ctx.prisma.chatLink.create({ data: { name: `Erase ${randomUUID()}`, numberId: number.id, message: 'Hi', ref: makeChatRef(randomInt), code: makeLinkCode(randomInt) } });
    const start = await ctx.prisma.chatLinkStart.create({ data: { chatLinkId: link.id, contactId: contact.id, newContact: true } });
    const endpoint = await ctx.prisma.webhookEndpoint.create({ data: { name: `Erase ${randomUUID()}`, url: 'https://hooks.example.test/in', secretEncrypted: 'x', eventTypes: ['message.received'] } });
    const event = await ctx.prisma.outboundEvent.create({ data: { type: 'message.received', occurredAt: now, data: { contact: { id: contact.id, phone }, text: 'my address is 5 Palm St' } } });
    const delivery = await ctx.prisma.webhookDelivery.create({ data: { endpointId: endpoint.id, eventId: event.id, status: 'PENDING', nextAttemptAt: now } });

    expect((await admin.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);
    expect(await ctx.prisma.storeCart.findUniqueOrThrow({ where: { id: cart.id } })).toMatchObject({ status: 'STOPPED', stopReason: 'deleted', nextAt: null, phoneE164: null, contactId: null });
    expect(await ctx.prisma.storeOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ codStatus: 'CLOSED', codNextAt: null, phoneE164: null, customerName: null, contactId: null });
    expect(await ctx.prisma.apiCampaignTrigger.findUniqueOrThrow({ where: { id: trigger.id } })).toMatchObject({ contactId: null, phoneE164: null, outcome: 'NOT_SENT' });
    expect(await ctx.prisma.chatLinkStart.findUniqueOrThrow({ where: { id: start.id } })).toMatchObject({ contactId: null, newContact: true });
    expect(await ctx.prisma.webhookDelivery.findUniqueOrThrow({ where: { id: delivery.id } })).toMatchObject({ status: 'CANCELLED', nextAttemptAt: null });
    expect((await ctx.prisma.outboundEvent.findUniqueOrThrow({ where: { id: event.id } })).data).toEqual({ contact: { id: contact.id } });
    await ctx.prisma.webhookEndpoint.delete({ where: { id: endpoint.id } });
  });

  it('clears their leads, keeps chats from ads without them, and keeps audience hashes for the removal at Meta (007)', async () => {
    const phone = uaePhone();
    const contact = await seedContact(ctx, phone, { name: 'Lead Person' });
    const form = await ctx.prisma.adLeadForm.create({ data: { name: `Erase form ${randomUUID()}`, questions: { standard: ['FULL_NAME', 'PHONE'] }, privacyUrl: 'https://example.com/p', consentText: 'WhatsApp offers please' } });
    const lead = await ctx.prisma.adLead.create({
      data: { formId: form.id, metaLeadId: randomUUID(), contactId: contact.id, phoneE164: phone, email: 'lead@example.com', answers: { full_name: 'Lead Person', phone_number: phone }, consent: true, status: 'PROCESSED', submittedAt: new Date() },
    });
    const start = await ctx.prisma.adChatStart.create({ data: { metaAdId: randomUUID().slice(0, 20), contactId: contact.id, newContact: true } });
    const audience = await ctx.prisma.adAudience.create({ data: { name: `Erase audience ${randomUUID()}`, kind: 'CUSTOM', source: { type: 'tag', tagId: randomUUID() }, status: 'READY', memberCount: 1 } });
    await ctx.prisma.adAudienceMember.create({ data: { audienceId: audience.id, contactId: contact.id, phoneHash: 'a'.repeat(64) } });

    expect((await admin.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);
    expect(await ctx.prisma.adLead.findUniqueOrThrow({ where: { id: lead.id } })).toMatchObject({ contactId: null, phoneE164: null, email: null, answers: {}, consent: true, status: 'PROCESSED' });
    expect(await ctx.prisma.adChatStart.findUniqueOrThrow({ where: { id: start.id } })).toMatchObject({ contactId: null, newContact: true });
    // The hash stays until the audience's next sync removes it at Meta (queued now).
    expect(await ctx.prisma.adAudienceMember.count({ where: { audienceId: audience.id, contactId: contact.id } })).toBe(1);
    await ctx.prisma.adAudience.delete({ where: { id: audience.id } });
  });

  it('cancels their waiting payment links, keeps requests and orders without their details, and deletes their form answers (008 FR-044)', async () => {
    const phone = uaePhone();
    const contact = await seedContact(ctx, phone, { name: 'Payer Person' });
    const order = await ctx.prisma.chatOrder.create({ data: { contactId: contact.id, catalogId: '900000000000001', customerText: 'Deliver to 5 Palm St', items: [], currency: 'AED', totalMinor: 4_500n, mode: 'AUTO', status: 'LINK_SENT' } });
    const request = (data: { status: 'WAITING' | 'PAID'; sessionId: string | null; chatOrderId?: string }) =>
      ctx.prisma.paymentRequest.create({
        data: {
          code: randomUUID().replace(/-/g, '').slice(0, 12),
          contactId: contact.id,
          phoneE164: phone,
          customerName: 'Payer Person',
          source: data.chatOrderId ? 'CHAT_ORDER' : 'INBOX',
          status: data.status,
          amountMinor: 4_500n,
          currency: 'AED',
          description: 'Order',
          expiresAt: new Date(Date.now() + 3_600_000),
          nextReminderAt: data.status === 'WAITING' ? new Date(Date.now() + 600_000) : null,
          sessionId: data.sessionId,
          chatOrderId: data.chatOrderId ?? null,
          ...(data.status === 'PAID' ? { paidAt: new Date(), paidAmountMinor: 4_500n } : {}),
        },
      });
    const waiting = await request({ status: 'WAITING', sessionId: `cs_test_${randomUUID().replace(/-/g, '')}`, chatOrderId: order.id });
    const lazy = await request({ status: 'WAITING', sessionId: null });
    const paid = await request({ status: 'PAID', sessionId: `cs_test_${randomUUID().replace(/-/g, '')}` });
    const form = await ctx.prisma.form.create({ data: { name: `Erase form ${randomUUID()}`, category: 'OTHER', status: 'PUBLISHED' } });
    const version = await ctx.prisma.formVersion.create({ data: { formId: form.id, number: 1, model: { screens: [] }, flowJson: {} } });
    await ctx.prisma.formAnswer.create({ data: { formId: form.id, formVersionId: version.id, contactId: contact.id, source: 'INBOX', answers: { address: '5 Palm St' } } });

    expect((await admin.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', admin.csrf)).status).toBe(204);
    const cleared = { contactId: null, phoneE164: null, customerName: null, amountMinor: 4_500n };
    expect(await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ ...cleared, status: 'CANCELLED', nextReminderAt: null, sessionExpirePending: true });
    expect(await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: lazy.id } })).toMatchObject({ ...cleared, status: 'CANCELLED', sessionExpirePending: false });
    expect(await ctx.prisma.paymentRequest.findUniqueOrThrow({ where: { id: paid.id } })).toMatchObject({ ...cleared, status: 'PAID', sessionExpirePending: false, paidAmountMinor: 4_500n });
    expect(await ctx.prisma.chatOrder.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({ contactId: null, customerText: null, totalMinor: 4_500n });
    expect(await ctx.prisma.formAnswer.count({ where: { formId: form.id } })).toBe(0);
    await ctx.prisma.paymentRequest.deleteMany({ where: { id: { in: [waiting.id, lazy.id, paid.id] } } });
    await ctx.prisma.chatOrder.delete({ where: { id: order.id } });
    await ctx.prisma.form.delete({ where: { id: form.id } });
  });

  it('is admin-only and returns 404 for unknown contacts', async () => {
    const contact = await seedContact(ctx, uaePhone());
    const manager = await signIn(ctx, 'MANAGER');
    expect((await manager.agent.delete(`/api/contacts/${contact.id}`).set('x-csrf-token', manager.csrf)).status).toBe(403);
    expect((await admin.agent.delete('/api/contacts/0190a000-0000-7000-8000-000000000000').set('x-csrf-token', admin.csrf)).status).toBe(404);
  });
});
