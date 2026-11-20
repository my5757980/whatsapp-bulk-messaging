import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import argon2 from 'argon2';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REDIS_CLIENT } from '../../src/common/queue/queue.module.js';
import type { InboxEventEnvelope } from '../../src/modules/inbox/realtime/event-filter.js';
import { InboxEventsService } from '../../src/modules/inbox/realtime/inbox-events.service.js';
import { INBOX_STREAM_OPTIONS, type InboxStreamOptions } from '../../src/modules/inbox/realtime/stream-fanout.service.js';
import { openSse, waitUntil, type SseStream } from '../support/sse-client.js';
import { createTestContext, TEST_PASSWORD, type TestContext } from '../support/test-context.js';

// T011: GET /api/inbox/events (contracts/realtime-events.md, research R1 and R9).
const options: InboxStreamOptions = { pingMs: 300, presenceTtlSeconds: 45, revalidateEveryPings: 4 };

let ctx: TestContext;
let base: string;
let events: InboxEventsService;
let redis: Redis;
const open: SseStream[] = [];

async function signInCookie(role: 'ADMIN' | 'MANAGER' | 'AGENT'): Promise<{ cookie: string; userId: string }> {
  const email = `${role.toLowerCase()}-${randomUUID()}@test.local`;
  const user = await ctx.prisma.user.create({
    data: { email, name: `${role} user`, role, status: 'ACTIVE', passwordHash: await argon2.hash(TEST_PASSWORD, { type: argon2.argon2id }) },
  });
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: TEST_PASSWORD }),
  });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return { cookie: res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; '), userId: user.id };
}

async function connect(cookie: string, lastEventId?: string): Promise<SseStream> {
  const stream = await openSse(`${base}/api/inbox/events`, { cookie, ...(lastEventId ? { 'last-event-id': lastEventId } : {}) });
  open.push(stream);
  if (stream.status === 200) await stream.waitFor((f) => f.comment === 'connected');
  return stream;
}

function envelope(over: Partial<InboxEventEnvelope> = {}): InboxEventEnvelope {
  return {
    type: 'message.created',
    conversationId: randomUUID(),
    numberId: randomUUID(),
    contactId: null,
    state: 'ACTIVE',
    intervenedById: null,
    blocked: false,
    at: new Date().toISOString(),
    data: {},
    ...over,
  };
}

async function publish(over: Partial<InboxEventEnvelope> = {}): Promise<string> {
  const id = await events.publish(envelope(over));
  if (!id) throw new Error('publish failed');
  return id;
}

beforeAll(async () => {
  ctx = await createTestContext([[INBOX_STREAM_OPTIONS, options]]);
  await ctx.app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(ctx.app.getHttpServer().address() as AddressInfo).port}`;
  events = ctx.app.get(InboxEventsService);
  redis = ctx.app.get<Redis>(REDIS_CLIENT);
});

afterAll(async () => {
  for (const stream of open) stream.close();
  await ctx.close();
});

describe('GET /api/inbox/events', () => {
  it('refuses visitors without a session', async () => {
    const res = await fetch(`${base}/api/inbox/events`);
    expect(res.status).toBe(401);
  });

  it('streams published events in order, with proxy-safe headers', async () => {
    const admin = await signInCookie('ADMIN');
    const res = await fetch(`${base}/api/inbox/events`, { headers: { cookie: admin.cookie } });
    expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
    expect(res.headers.get('cache-control')).toContain('no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    await res.body?.cancel();

    const stream = await connect(admin.cookie);
    const first = await publish({ data: { n: 1 } });
    const second = await publish({ type: 'message.status', data: { n: 2 } });
    await stream.waitFor((f) => f.id === second);
    const received = stream.frames.filter((f) => f.id);
    expect(received.map((f) => f.id)).toEqual([first, second]);
    expect(received.map((f) => f.event)).toEqual(['message.created', 'message.status']);
    expect(JSON.parse(received[0]!.data!)).toEqual({ n: 1 });
  });

  it('sends a ping comment and keeps the presence key while connected', async () => {
    const agent = await signInCookie('AGENT');
    const stream = await connect(agent.cookie);
    await stream.waitFor((f) => f.comment === 'ping', 3_000);
    const ttl = await redis.ttl(`wbm:presence:${agent.userId}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(options.presenceTtlSeconds);

    stream.close();
    await waitUntil(async () => (await redis.exists(`wbm:presence:${agent.userId}`)) === 0, 3_000);
  });

  it('replays the events after Last-Event-ID', async () => {
    const admin = await signInCookie('ADMIN');
    const a = await publish({ data: { n: 'a' } });
    const b = await publish({ data: { n: 'b' } });
    const c = await publish({ data: { n: 'c' } });
    const stream = await connect(admin.cookie, a);
    await stream.waitFor((f) => f.id === c);
    expect(stream.frames.filter((f) => f.id).map((f) => f.id)).toEqual([b, c]);
  });

  it('asks the client to resync when the ID is no longer in the stream', async () => {
    const admin = await signInCookie('ADMIN');
    await publish();
    const stream = await connect(admin.cookie, '1-0');
    await stream.waitFor((f) => f.event === 'resync');
  });

  it('sends agents only the chats they may see', async () => {
    const agent = await signInCookie('AGENT');
    const stream = await connect(agent.cookie);
    const hidden = await publish({ state: 'INTERVENED', intervenedById: randomUUID() });
    const own = await publish({ state: 'INTERVENED', intervenedById: agent.userId });
    const visible = await publish({ state: 'REQUESTING' });
    await stream.waitFor((f) => f.id === visible);
    const ids = stream.frames.filter((f) => f.id).map((f) => f.id);
    expect(ids).toEqual([own, visible]);
    expect(ids).not.toContain(hidden);
  });

  it('never sends events about blocked contacts', async () => {
    const admin = await signInCookie('ADMIN');
    const stream = await connect(admin.cookie);
    const blocked = await publish({ blocked: true });
    const after = await publish();
    await stream.waitFor((f) => f.id === after);
    expect(stream.frames.some((f) => f.id === blocked)).toBe(false);
  });
});
