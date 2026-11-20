import { randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SessionSendProcessor } from '../../src/modules/inbox/messages/session-send.processor.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { META_BASE, META_VERSION, restoreNetwork, seedNumber, setDefaultCountry, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T058: US4 - saved replies and the media library (FR-015, FR-030-FR-032, research R15).
describe('Live chat: saved replies and media (US4)', () => {
  let ctx: TestContext;
  let number: { id: string; phoneNumberId: string };
  let admin: SignedInAgent;
  let manager: SignedInAgent;
  let agent: SignedInAgent;
  const MB = 1024 * 1024;

  const post = (who: SignedInAgent, path: string) => who.agent.post(path).set('X-CSRF-Token', who.csrf);
  const newChat = async (name = 'Sara Khan') => {
    const phone = uaePhone();
    const payload = webhook.inbound(number.phoneNumberId, phone.slice(1), 'hello');
    (payload.entry[0]!.changes[0]!.value.contacts[0] as { profile?: { name: string } }).profile = { name };
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, payload));
    const chat = await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } });
    return { phone, chat };
  };
  const upload = (who: SignedInAgent, name: string, type: string, bytes: Buffer, displayName?: string) => {
    const req = post(who, '/api/media-library').attach('file', bytes, { filename: name, contentType: type });
    return displayName ? req.field('displayName', displayName) : req;
  };

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    manager = await signIn(ctx, 'MANAGER');
    agent = await signIn(ctx, 'AGENT');
  });

  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  it('lets admins and managers manage saved replies; agents can only use them', async () => {
    const name = `Opening hours ${randomUUID().slice(0, 6)}`;
    const created = await post(manager, '/api/canned-messages').send({ name, type: 'TEXT', text: 'Hi {first_name}, we open at {{1}}', variableFallbacks: { first_name: 'there' } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name, type: 'TEXT', parameterCount: 1, favorite: false, createdBy: { id: manager.userId } });

    expect((await post(manager, '/api/canned-messages').send({ name: name.toUpperCase(), type: 'TEXT', text: 'dup' })).status).toBe(409);
    const edited = await manager.agent.patch(`/api/canned-messages/${created.body.id}`).set('X-CSRF-Token', manager.csrf).send({ name, type: 'TEXT', text: 'Hi {first_name}, we open at {{1}} today' });
    expect(edited.status).toBe(200);
    expect(edited.body.text).toContain('today');

    expect((await post(agent, '/api/canned-messages').send({ name: `x${randomUUID()}`, type: 'TEXT', text: 'x' })).status).toBe(403);
    expect((await agent.agent.delete(`/api/canned-messages/${created.body.id}`).set('X-CSRF-Token', agent.csrf)).status).toBe(403);
    expect((await agent.agent.get('/api/canned-messages')).status).toBe(200);
  });

  it('keeps favourites per member and lists them first', async () => {
    const tag = randomUUID().slice(0, 6);
    const a = await post(admin, '/api/canned-messages').send({ name: `A ${tag}`, type: 'TEXT', text: 'first' });
    const b = await post(admin, '/api/canned-messages').send({ name: `B ${tag}`, type: 'TEXT', text: 'second' });
    expect((await agent.agent.put(`/api/canned-messages/${b.body.id}/favorite`).set('X-CSRF-Token', agent.csrf)).status).toBe(204);

    const forAgent = (await agent.agent.get('/api/canned-messages').query({ q: tag })).body as Array<{ id: string; favorite: boolean }>;
    expect(forAgent.map((c) => [c.id, c.favorite])).toEqual([
      [b.body.id, true],
      [a.body.id, false],
    ]);
    const forAdmin = (await admin.agent.get('/api/canned-messages').query({ q: tag })).body as Array<{ id: string; favorite: boolean }>;
    expect(forAdmin.every((c) => !c.favorite)).toBe(true);
    expect((await agent.agent.delete(`/api/canned-messages/${b.body.id}/favorite`).set('X-CSRF-Token', agent.csrf)).status).toBe(204);
  });

  it('stops at 200 saved replies', async () => {
    const existing = await ctx.prisma.cannedMessage.count();
    await ctx.prisma.cannedMessage.createMany({
      data: Array.from({ length: Math.max(0, 200 - existing) }, (_, i) => ({ name: `bulk-${randomUUID()}-${i}`, type: 'TEXT' as const, text: 'x' })),
    });
    const res = await post(admin, '/api/canned-messages').send({ name: `one too many ${randomUUID()}`, type: 'TEXT', text: 'x' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('LIMIT_REACHED');
    await ctx.prisma.cannedMessage.deleteMany({ where: { name: { startsWith: 'bulk-' } } });
  });

  it('sends a saved reply with its variables and parameters filled in', async () => {
    const { chat } = await newChat('Sara Khan');
    const canned = await post(admin, '/api/canned-messages').send({ name: `Hours ${randomUUID().slice(0, 6)}`, type: 'TEXT', text: 'Hi {first_name}, we open at {{1}}' });
    const missing = await post(agent, `/api/inbox/conversations/${chat.id}/messages`).send({ type: 'canned', cannedMessageId: canned.body.id });
    expect(missing.status).toBe(422);
    expect(missing.body.code).toBe('PARAMS_MISSING');
    const sent = await post(agent, `/api/inbox/conversations/${chat.id}/messages`).send({ type: 'canned', cannedMessageId: canned.body.id, params: { '1': '9 am' } });
    expect(sent.status).toBe(202);
    expect(sent.body).toMatchObject({ kind: 'SESSION_OUT', contentType: 'TEXT', text: 'Hi Sara, we open at 9 am', status: 'QUEUED' });
  });

  it('accepts library uploads within the chat limits and refuses the rest', async () => {
    const ok = await upload(agent, 'menu.pdf', 'application/pdf', Buffer.from('%PDF-1.4 test'), 'Menu');
    expect(ok.status).toBe(201);
    expect(ok.body).toMatchObject({ displayName: 'Menu', mimeType: 'application/pdf', kind: 'document', uploadedBy: { id: agent.userId } });

    const big = await upload(agent, 'clip.mp4', 'video/mp4', Buffer.alloc(16 * MB + 1));
    expect(big.status).toBe(422);
    expect(big.body).toMatchObject({ code: 'FILE_TOO_LARGE', message: 'Videos can be at most 16 MB' });
    expect((await upload(agent, 'anim.gif', 'image/gif', Buffer.from('GIF89a'))).body.code).toBe('UNSUPPORTED_FILE_TYPE');

    const list = await agent.agent.get('/api/media-library').query({ kind: 'document' });
    expect(list.status).toBe(200);
    expect((list.body.items as Array<{ id: string }>).some((m) => m.id === ok.body.id)).toBe(true);
  });

  it('sends library media, uploading it to Meta once per number', async () => {
    const { phone, chat } = await newChat();
    const file = await upload(admin, 'menu.pdf', 'application/pdf', Buffer.from('%PDF-1.4 menu'), 'Menu');
    const metaId = `media-${randomUUID()}`;
    const uploads = nock(META_BASE).post(`/${META_VERSION}/${number.phoneNumberId}/media`).once().reply(200, { id: metaId });
    const bodies: Array<Record<string, unknown>> = [];
    // One interceptor per send: Meta returns a different wamid for every message.
    for (let i = 0; i < 2; i++) {
      nock(META_BASE)
        .post(`/${META_VERSION}/${number.phoneNumberId}/messages`, (body: Record<string, unknown>) => {
          bodies.push(body);
          return true;
        })
        .reply(200, { messages: [{ id: `wamid.${randomUUID()}` }] });
    }

    for (const caption of ['Our menu', 'Again']) {
      const sent = await post(agent, `/api/inbox/conversations/${chat.id}/messages`).send({ type: 'media', mediaAssetId: file.body.id, text: caption, fileName: 'menu.pdf' });
      expect(sent.status).toBe(202);
      expect(sent.body).toMatchObject({ contentType: 'DOCUMENT', text: caption, media: { id: file.body.id } });
      expect(await ctx.app.get(SessionSendProcessor).process(sent.body.id as string, 1)).toMatchObject({ result: 'sent' });
    }
    expect(uploads.isDone()).toBe(true);
    expect(bodies[0]).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: phone.slice(1),
      type: 'document',
      document: { id: metaId, caption: 'Our menu', filename: 'menu.pdf' },
    });

    // Removing the item from the library keeps what was already sent.
    expect((await agent.agent.delete(`/api/media-library/${file.body.id}`).set('X-CSRF-Token', agent.csrf)).status).toBe(403);
    expect((await manager.agent.delete(`/api/media-library/${file.body.id}`).set('X-CSRF-Token', manager.csrf)).status).toBe(204);
    const library = await agent.agent.get('/api/media-library').query({ kind: 'document', pageSize: 100 });
    expect((library.body.items as Array<{ id: string }>).some((m) => m.id === file.body.id)).toBe(false);
    const items = await agent.agent.get(`/api/inbox/conversations/${chat.id}/items`);
    expect(items.body.items[0]).toMatchObject({ contentType: 'DOCUMENT', media: { id: file.body.id, state: 'READY' } });
    expect((await agent.agent.get(`/api/inbox/media/${file.body.id}`)).status).toBe(200);
  });

  it('refuses media over the limits and audio captions', async () => {
    const { chat } = await newChat();
    const res = await post(agent, `/api/inbox/conversations/${chat.id}/messages`).send({ type: 'media', mediaUrl: 'http://insecure.example/a.jpg' });
    expect(res.status).toBe(422);
    const voice = await upload(admin, 'note.ogg', 'audio/ogg', Buffer.from('OggS'));
    const audio = await post(agent, `/api/inbox/conversations/${chat.id}/messages`).send({ type: 'media', mediaAssetId: voice.body.id, text: 'listen' });
    expect(audio.status).toBe(202);
    expect(audio.body).toMatchObject({ contentType: 'AUDIO', text: null });
  });
});
