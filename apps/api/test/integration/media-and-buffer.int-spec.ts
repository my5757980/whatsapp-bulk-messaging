import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { MediaService } from '../../src/modules/media/media.service.js';
import { StatusHandler } from '../../src/modules/webhooks/handlers/status.handler.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { META_BASE, META_VERSION, NUMBER_TOKEN, digits, restoreNetwork, seedContact, seedNumber, seedRunningCampaign, seedTemplate, uaePhone, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T090 (media upload + lazy Meta media id) and T077/T101 (status events for an unknown wamid are
// buffered until the send worker stores the id).
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('Media uploads', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;

  beforeAll(async () => {
    ctx = await createTestContext();
    admin = await signIn(ctx, 'ADMIN');
    useNockLocalOnly();
  });
  afterEach(() => nock.cleanAll());
  afterAll(async () => {
    restoreNetwork();
    await ctx.close();
  });

  const upload = (who: SignedInAgent, file: Buffer, contentType: string, purpose = 'CAMPAIGN_HEADER') =>
    who.agent.post('/api/media').set('x-csrf-token', who.csrf).field('purpose', purpose).attach('file', file, { filename: 'header', contentType });

  it('stores supported media and rejects other types', async () => {
    const res = await upload(admin, PNG, 'image/png');
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ id: expect.any(String), mimeType: 'image/png', sizeBytes: PNG.length, purpose: 'CAMPAIGN_HEADER' });

    const text = await upload(admin, Buffer.from('hello'), 'text/plain');
    expect(text.status).toBe(422);
    expect((await upload(admin, PNG, 'image/png', 'OTHER')).status).toBe(422);

    const agent = await signIn(ctx, 'AGENT');
    expect((await upload(agent, PNG, 'image/png')).status).toBe(403);
  });

  it('uploads to Meta once per number and reuses the media id', async () => {
    const created = await upload(admin, PNG, 'image/png');
    const number = await seedNumber(ctx);
    const scope = nock(META_BASE)
      .post(`/${META_VERSION}/${number.phoneNumberId}/media`)
      .matchHeader('authorization', `Bearer ${NUMBER_TOKEN}`)
      .reply(200, { id: 'MEDIA-123' });

    const media = ctx.app.get(MediaService);
    expect(await media.ensureMetaMediaId(created.body.id, number)).toBe('MEDIA-123');
    expect(await media.ensureMetaMediaId(created.body.id, number)).toBe('MEDIA-123'); // cached, no second call
    expect(scope.isDone()).toBe(true);
  });
});

describe('Status events before the wamid is stored', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => ctx.close());

  it('buffers them and applies them once the send worker stores the id', async () => {
    const admin = await signIn(ctx, 'ADMIN');
    const number = await seedNumber(ctx);
    const template = await seedTemplate(ctx, number.wabaId);
    const contact = await seedContact(ctx, uaePhone());
    const campaign = await seedRunningCampaign(ctx, { numberId: number.id, templateId: template.id, createdById: admin.userId, contacts: [contact] });
    const wamid = `wamid.early.${digits(8)}`;

    // Meta's "delivered" arrives while the send call is still returning.
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.status(number.phoneNumberId, wamid, contact.phoneE164.slice(1), 'delivered')));
    const message = await ctx.prisma.message.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(message.status).toBe('PENDING');

    await ctx.prisma.message.update({ where: { id: message.id }, data: { status: 'SENT', waMessageId: wamid, sentAt: new Date() } });
    await ctx.app.get(StatusHandler).applyBuffered(wamid);

    const after = await ctx.prisma.message.findUniqueOrThrow({ where: { id: message.id }, include: { events: true } });
    expect(after.status).toBe('DELIVERED');
    expect(after.deliveredAt).toBeTruthy();
    expect(after.events.map((e) => e.type)).toEqual(['DELIVERED']);
    await ctx.app.get(StatusHandler).applyBuffered(wamid); // buffer is drained; nothing applies twice
    expect(await ctx.prisma.messageEvent.count({ where: { messageId: message.id } })).toBe(1);
  });
});
