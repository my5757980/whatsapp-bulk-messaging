import { createHmac } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../src/common/prisma/prisma.service.js';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { createTestApp } from '../support/create-app.js';

// T060: verification handshake and signed ingestion (contracts/meta-webhooks.md §1-2).
describe('Meta webhook ingestion', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const sign = (raw: string) =>
    `sha256=${createHmac('sha256', process.env.META_APP_SECRET as string).update(raw).digest('hex')}`;

  beforeAll(async () => {
    app = await createTestApp();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('answers the verification handshake with the challenge', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/webhooks/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': process.env.META_WEBHOOK_VERIFY_TOKEN, 'hub.challenge': '1158201444' });
    expect(res.status).toBe(200);
    expect(res.text).toBe('1158201444');
  });

  it('refuses the handshake with a wrong verify token', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/webhooks/meta')
      .query({ 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '1' });
    expect(res.status).toBe(403);
  });

  it('rejects unsigned events with 401 and records them without payload', async () => {
    const before = await prisma.webhookEvent.count({ where: { signatureValid: false } });
    const res = await request(app.getHttpServer())
      .post('/api/webhooks/meta')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
    expect(res.status).toBe(401);
    const rows = await prisma.webhookEvent.findMany({ where: { signatureValid: false } });
    expect(rows.length).toBe(before + 1);
    expect(rows.at(-1)?.payload).toBeNull();
  });

  it('stores signed events, enqueues them and returns 200', async () => {
    const raw = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [] }] });
    const res = await request(app.getHttpServer())
      .post('/api/webhooks/meta')
      .set('content-type', 'application/json')
      .set('X-Hub-Signature-256', sign(raw))
      .send(raw);
    expect(res.status).toBe(200);

    const event = await prisma.webhookEvent.findFirstOrThrow({ where: { signatureValid: true }, orderBy: { receivedAt: 'desc' } });
    expect(event.payload).toEqual(JSON.parse(raw));
    const job = await app.get(QueueRegistry).get(QUEUES.WEBHOOKS).getJob(`wh-${event.id}`);
    expect(job?.data).toEqual({ webhookEventId: event.id });
  });
});
