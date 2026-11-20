import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { APP_CONFIG } from '../../src/common/config/config.module.js';
import type { AppConfig } from '../../src/common/config/config.js';
import { maskPhone } from '../../src/common/phone/phone.js';
import { QueueRegistry, REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import { INBOX_QUEUE, type InboxNotifyJobData } from '../../src/modules/inbox/inbox-queue.js';
import { InboxNotifyProcessor } from '../../src/modules/inbox/notifications/inbox-notify.processor.js';
import { PUSH_SENDER, type PushSender, type PushTarget } from '../../src/modules/inbox/notifications/push-sender.js';
import { presenceKey } from '../../src/modules/inbox/realtime/stream-fanout.service.js';
import { WebhooksProcessor } from '../../src/modules/webhooks/webhooks.processor.js';
import { seedNumber, setDefaultCountry, uaePhone } from '../support/fixtures.js';
import { createTestContext, postSignedWebhook, signIn, webhook, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T083: US7 - the sound preference, push devices, and push alerts only for members who are away
// (FR-037, FR-029, FR-034, research R9). The web-push transport is replaced by a fake.
describe('Live chat: alerts (US7)', () => {
  let ctx: TestContext;
  let redis: Redis;
  let number: { id: string; phoneNumberId: string; wabaId: string };
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  let originalSettings: Record<string, unknown>;
  const pushed: Array<{ endpoint: string; payload: { title: string; body: string; url: string; tag: string } }> = [];
  const gone = new Set<string>();
  const fakeSender: PushSender = {
    enabled: true,
    send: async (target: PushTarget, payload: string) => {
      if (gone.has(target.endpoint)) throw Object.assign(new Error('Subscription expired'), { statusCode: 410 });
      pushed.push({ endpoint: target.endpoint, payload: JSON.parse(payload) });
    },
  };
  const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };
  const endpoint = (who: string) => `https://push.example.test/${who}/${randomUUID()}`;
  const register = (member: SignedInAgent, url: string, label?: string) =>
    member.agent
      .post('/api/me/push-devices')
      .set('X-CSRF-Token', member.csrf)
      .send({ endpoint: url, keys: KEYS, ...(label ? { label } : {}) });
  const pause = (member: SignedInAgent, id: string, paused: boolean) =>
    member.agent.patch(`/api/me/push-devices/${id}`).set('X-CSRF-Token', member.csrf).send({ paused });
  const inbound = async (phone: string, text: string): Promise<string> => {
    await ctx.app.get(WebhooksProcessor).process(await postSignedWebhook(ctx, webhook.inbound(number.phoneNumberId, phone.slice(1), text)));
    return (await ctx.prisma.conversation.findFirstOrThrow({ where: { contact: { phoneE164: phone } } })).id;
  };
  /** Runs the queued alerts for a chat, as the worker would (workers do not run in tests). */
  const drain = async (conversationId: string): Promise<Array<InboxNotifyJobData['kind']>> => {
    const queue = ctx.app.get(QueueRegistry).get(INBOX_QUEUE);
    const jobs = (await queue.getJobs(['waiting', 'prioritized', 'delayed'])).filter((j) => j.name === 'notify' && j.data.conversationId === conversationId);
    jobs.sort((a, b) => a.timestamp - b.timestamp);
    for (const job of jobs) {
      await ctx.app.get(InboxNotifyProcessor).process(job.data as InboxNotifyJobData);
      await job.remove();
    }
    return jobs.map((j) => (j.data as InboxNotifyJobData).kind);
  };

  beforeAll(async () => {
    ctx = await createTestContext([[PUSH_SENDER, fakeSender]]);
    redis = ctx.app.get<Redis>(REDIS_CLIENT);
    await setDefaultCountry(ctx, 'AE');
    number = await seedNumber(ctx);
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
    originalSettings = (await admin.agent.get('/api/live-chat/settings')).body as Record<string, unknown>;
    const res = await admin.agent
      .put('/api/live-chat/settings')
      .set('X-CSRF-Token', admin.csrf)
      .send({ ...originalSettings, humanKeywords: ['talk to a person'], welcomeEnabled: false, welcomeContent: null, offHoursEnabled: false, offHoursContent: null });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  beforeEach(() => {
    pushed.length = 0;
  });

  // Each test starts without devices, so only the members it registers can be alerted.
  afterEach(async () => {
    await ctx.prisma.pushDevice.deleteMany({ where: { endpoint: { startsWith: 'https://push.example.test/' } } });
  });

  afterAll(async () => {
    await admin.agent.put('/api/live-chat/settings').set('X-CSRF-Token', admin.csrf).send(originalSettings);
    await ctx.close();
  });

  it('saves the new-message sound preference', async () => {
    expect((await agent.agent.get('/api/me/notification-preferences')).body).toEqual({ soundEnabled: true });
    const put = (body: unknown) => agent.agent.put('/api/me/notification-preferences').set('X-CSRF-Token', agent.csrf).send(body as object);
    const saved = await put({ soundEnabled: false });
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ soundEnabled: false });
    expect((await agent.agent.get('/api/me/notification-preferences')).body).toEqual({ soundEnabled: false });
    expect((await put({ soundEnabled: 'off' })).status).toBe(422);
    await put({ soundEnabled: true });
  });

  it('registers at most 5 devices per member, and pauses and removes them', async () => {
    const member = await signIn(ctx, 'AGENT');
    const urls = Array.from({ length: 5 }, () => endpoint('limit'));
    for (const url of urls) expect((await register(member, url)).status).toBe(201);
    const sixth = await register(member, endpoint('limit'));
    expect(sixth.status).toBe(422);
    expect(sixth.body.code).toBe('DEVICE_LIMIT');

    // The same browser again refreshes its keys and label instead of adding a device.
    const again = await register(member, urls[0]!, 'Work laptop');
    expect(again.status).toBe(201);
    expect(again.body).toMatchObject({ label: 'Work laptop', paused: false, lastSuccessAt: null });
    const list = await member.agent.get('/api/me/push-devices');
    expect(list.body).toHaveLength(5);

    const paused = await pause(member, again.body.id, true);
    expect(paused.status).toBe(200);
    expect(paused.body.paused).toBe(true);
    expect((await member.agent.delete(`/api/me/push-devices/${again.body.id}`).set('X-CSRF-Token', member.csrf)).status).toBe(204);
    expect((await register(member, endpoint('limit'))).status).toBe(201);

    // Someone else's device, and a subscription that is not https.
    expect((await pause(admin, list.body[1].id, true)).status).toBe(404);
    expect((await admin.agent.delete(`/api/me/push-devices/${list.body[1].id}`).set('X-CSRF-Token', admin.csrf)).status).toBe(404);
    expect((await register(member, 'http://push.example.test/plain')).status).toBe(422);
  });

  it('gives the browser the VAPID public key, or null when push is not configured', async () => {
    const res = await agent.agent.get('/api/push/vapid-public-key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ publicKey: ctx.app.get<AppConfig>(APP_CONFIG).WEB_PUSH_PUBLIC_KEY ?? null });
  });

  it('alerts members who may see a new customer message, only while they are away', async () => {
    const adminDevice = endpoint('admin');
    const agentDevice = endpoint('agent');
    expect((await register(admin, adminDevice)).status).toBe(201);
    expect((await register(agent, agentDevice)).status).toBe(201);

    // The agent has the dashboard open (the live stream keeps this key fresh).
    await redis.set(presenceKey(agent.userId), '1', 'EX', 45);
    const phone = uaePhone();
    const id = await inbound(phone, `Hello ${'x'.repeat(200)}`);
    expect(await drain(id)).toEqual(['message']);
    expect(pushed.map((p) => p.endpoint)).toEqual([adminDevice]);
    expect(pushed[0]!.payload).toMatchObject({ title: phone, url: `/inbox?c=${id}`, tag: `chat-${id}` });
    expect(pushed[0]!.payload.body.length).toBeLessThanOrEqual(80);
    expect((await ctx.prisma.pushDevice.findUniqueOrThrow({ where: { endpoint: adminDevice } })).lastSuccessAt).not.toBeNull();

    // Away now: the agent is alerted too, with the phone number masked (FR-029).
    pushed.length = 0;
    await redis.del(presenceKey(agent.userId));
    await inbound(phone, 'Second message');
    await drain(id);
    expect(pushed.find((p) => p.endpoint === agentDevice)?.payload).toMatchObject({ title: maskPhone(phone), body: 'Second message' });
    expect(pushed.find((p) => p.endpoint === adminDevice)?.payload.title).toBe(phone);
  });

  it('alerts for chats waiting for an agent and for transfers', async () => {
    const adminDevice = endpoint('admin-routing');
    const agentDevice = endpoint('agent-routing');
    await register(admin, adminDevice);
    await register(agent, agentDevice);
    const phone = uaePhone();
    const id = await inbound(phone, 'Talk to a person');
    // One alert, not a new-message alert as well.
    expect(await drain(id)).toEqual(['requesting']);
    expect(pushed.find((p) => p.endpoint === adminDevice)?.payload).toMatchObject({ title: 'Waiting for an agent', body: `${phone} asked to talk to a person` });
    expect(pushed.find((p) => p.endpoint === agentDevice)?.payload).toMatchObject({ body: `${maskPhone(phone)} asked to talk to a person` });

    pushed.length = 0;
    const take = await admin.agent.post(`/api/inbox/conversations/${id}/intervene`).set('X-CSRF-Token', admin.csrf);
    expect(take.status, JSON.stringify(take.body)).toBe(200);
    const transfer = await admin.agent.post(`/api/inbox/conversations/${id}/transfer`).set('X-CSRF-Token', admin.csrf).send({ userId: agent.userId });
    expect(transfer.status, JSON.stringify(transfer.body)).toBe(200);
    expect(await drain(id)).toEqual(['transferred']);
    expect(pushed.map((p) => p.endpoint)).toEqual([agentDevice]);
    expect(pushed[0]!.payload.title).toBe('Chat transferred to you');
  });

  it('skips paused devices and blocked contacts, and drops devices the push service forgot', async () => {
    const manager = await signIn(ctx, 'MANAGER');
    const pausedUrl = endpoint('paused');
    const goneUrl = endpoint('gone');
    const liveUrl = endpoint('live');
    const pausedDevice = await register(manager, pausedUrl);
    await pause(manager, pausedDevice.body.id, true);
    const goneDevice = await register(manager, goneUrl);
    gone.add(goneUrl);
    await register(manager, liveUrl);

    const phone = uaePhone();
    const id = await inbound(phone, 'Hello');
    await drain(id);
    const reached = pushed.map((p) => p.endpoint);
    expect(reached).toContain(liveUrl);
    expect(reached).not.toContain(pausedUrl);
    expect(await ctx.prisma.pushDevice.findUnique({ where: { id: goneDevice.body.id } })).toBeNull();
    expect(await ctx.prisma.pushDevice.findUnique({ where: { id: pausedDevice.body.id } })).not.toBeNull();

    // Blocked contacts raise no alerts (FR-034).
    pushed.length = 0;
    await ctx.prisma.contact.updateMany({ where: { phoneE164: phone }, data: { blockedAt: new Date() } });
    await inbound(phone, 'Still there?');
    expect(await drain(id)).toEqual([]);
    expect(pushed).toEqual([]);
  });
});
