import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp } from '../support/create-app.js';

// T036: /api/health and /metrics require X-Ops-Token (constitution Principle III).
describe('ops endpoints', () => {
  let app: INestApplication;
  const token = () => process.env.OPS_TOKEN as string;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
  });

  it.each(['/api/health', '/metrics'])('%s rejects requests without a token', async (path) => {
    const res = await request(app.getHttpServer()).get(path);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it.each(['/api/health', '/metrics'])('%s rejects a wrong token', async (path) => {
    const res = await request(app.getHttpServer()).get(path).set('X-Ops-Token', 'wrong-token-value');
    expect(res.status).toBe(401);
  });

  it('GET /api/health reports database and Redis status with the right token', async () => {
    const res = await request(app.getHttpServer()).get('/api/health').set('X-Ops-Token', token());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'ok', redis: 'ok' });
  });

  it('GET /metrics exposes delivery metrics with the right token', async () => {
    const res = await request(app.getHttpServer()).get('/metrics').set('X-Ops-Token', token());
    expect(res.status).toBe(200);
    expect(res.text).toContain('wbm_messages_total');
    // Queue depths are read from Redis at scrape time (T194), one series per queue.
    expect(res.text).toMatch(/^wbm_queue_depth\{queue="webhooks"\} \d+$/m);
    expect(res.text).toMatch(/^wbm_queue_depth\{queue="campaign-dispatch"\} \d+$/m);
  });
});
