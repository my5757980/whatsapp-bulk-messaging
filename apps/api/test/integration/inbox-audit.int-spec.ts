import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T098: live chat actions land in the existing audit log without message content (FR-040).
describe('Live chat: audit log (FR-040)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  const SECRET_TEXT = `Private reply text ${randomUUID()}`;

  const entries = (actorUserId: string, action: string) => ctx.prisma.auditLog.findMany({ where: { actorUserId, action }, orderBy: { createdAt: 'asc' } });
  const post = (member: SignedInAgent, url: string, body?: object) => member.agent.post(url).set('X-CSRF-Token', member.csrf).send(body);

  beforeAll(async () => {
    ctx = await createTestContext();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
  });

  afterAll(async () => {
    await ctx.close();
  });

  it('records take, transfer, close, block and unblock', async () => {
    const phone = uaePhone();
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), SECRET_TEXT)));
    const chat = await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });

    expect((await post(admin, `/api/inbox/conversations/${chat.id}/intervene`)).status).toBe(200);
    expect((await post(admin, `/api/inbox/conversations/${chat.id}/transfer`, { userId: agent.userId })).status).toBe(200);
    expect((await post(agent, `/api/inbox/conversations/${chat.id}/resolve`)).status).toBe(200);
    expect((await post(agent, `/api/contacts/${chat.contactId}/block`)).status).toBe(204);
    expect((await agent.agent.delete(`/api/contacts/${chat.contactId}/block`).set('X-CSRF-Token', agent.csrf)).status).toBe(204);

    expect(await entries(admin.userId, 'inbox.intervened')).toMatchObject([{ targetType: 'conversation', targetId: chat.id }]);
    expect(await entries(admin.userId, 'inbox.transferred')).toMatchObject([{ targetId: chat.id, metadata: { fromUserId: admin.userId, toUserId: agent.userId } }]);
    expect(await entries(agent.userId, 'inbox.resolved')).toMatchObject([{ targetId: chat.id, metadata: { ownerId: agent.userId } }]);
    expect(await entries(agent.userId, 'contact.blocked')).toMatchObject([{ targetType: 'contact', targetId: chat.contactId }]);
    expect(await entries(agent.userId, 'contact.unblocked')).toHaveLength(1);
  });

  it('records saved reply, media library, settings and agent rule changes without their content', async () => {
    const created = await post(admin, '/api/canned-messages', { name: `audit-${randomUUID().slice(0, 6)}`, type: 'TEXT', text: SECRET_TEXT });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect((await admin.agent.patch(`/api/canned-messages/${created.body.id}`).set('X-CSRF-Token', admin.csrf).send({ name: created.body.name, type: 'TEXT', text: `${SECRET_TEXT}!` })).status).toBe(200);
    expect((await admin.agent.delete(`/api/canned-messages/${created.body.id}`).set('X-CSRF-Token', admin.csrf)).status).toBe(204);

    const upload = await admin.agent
      .post('/api/media-library')
      .set('X-CSRF-Token', admin.csrf)
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xd9]), { filename: 'menu.jpg', contentType: 'image/jpeg' });
    expect(upload.status).toBe(201);
    expect((await admin.agent.delete(`/api/media-library/${upload.body.id}`).set('X-CSRF-Token', admin.csrf)).status).toBe(204);

    const settings = (await admin.agent.get('/api/live-chat/settings')).body as Record<string, unknown>;
    const changed = await admin.agent
      .put('/api/live-chat/settings')
      .set('X-CSRF-Token', admin.csrf)
      .send({ ...settings, offHoursEnabled: true, offHoursContent: { kind: 'TEXT', text: SECRET_TEXT } });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    await admin.agent.put('/api/live-chat/settings').set('X-CSRF-Token', admin.csrf).send(settings);

    const tag = await ctx.prisma.tag.create({ data: { name: `audit-${randomUUID().slice(0, 6)}` } });
    expect((await admin.agent.put(`/api/users/${agent.userId}/agent-rules`).set('X-CSRF-Token', admin.csrf).send([{ kind: 'TAG', tagId: tag.id }])).status).toBe(200);
    await admin.agent.put(`/api/users/${agent.userId}/agent-rules`).set('X-CSRF-Token', admin.csrf).send([]);

    for (const action of ['canned.created', 'canned.updated', 'canned.deleted']) {
      expect(await entries(admin.userId, action)).toMatchObject([{ targetType: 'canned_message', targetId: created.body.id, metadata: { name: created.body.name } }]);
    }
    expect(await entries(admin.userId, 'media.removed')).toMatchObject([{ targetId: upload.body.id, metadata: { mimeType: 'image/jpeg', keptForChats: false } }]);
    const settingChanges = await entries(admin.userId, 'livechat.settings_updated');
    expect(settingChanges.length).toBeGreaterThanOrEqual(1);
    expect(settingChanges[0]!.metadata).toMatchObject({ changed: expect.arrayContaining(['offHoursEnabled', 'offHoursContent']) });
    expect(await entries(admin.userId, 'agent_rules.updated')).toMatchObject([
      { targetType: 'user', targetId: agent.userId, metadata: { rules: 1 } },
      { targetType: 'user', targetId: agent.userId, metadata: { rules: 0 } },
    ]);

    // Message content never reaches the audit log.
    const all = await ctx.prisma.auditLog.findMany({ where: { actorUserId: { in: [admin.userId, agent.userId] } } });
    expect(JSON.stringify(all)).not.toContain(SECRET_TEXT);
  });
});
