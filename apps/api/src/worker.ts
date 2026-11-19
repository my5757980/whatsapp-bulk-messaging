import 'reflect-metadata';
import { createServer } from 'node:http';
import { NestFactory } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { Logger } from 'nestjs-pino';
import { isValidOpsToken } from './common/auth/ops-token.guard.js';
import { APP_CONFIG } from './common/config/config.module.js';
import { assertRedisNoEviction, type AppConfig } from './common/config/config.js';
import { MetricsService } from './common/metrics/metrics.service.js';
import { REDIS_CLIENT } from './common/queue/queue.module.js';
import { WorkerModule } from './worker.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(WorkerModule, { bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<AppConfig>(APP_CONFIG);
  if ((await assertRedisNoEviction(app.get<Redis>(REDIS_CLIENT))) === 'unverifiable') {
    logger.warn('Could not read Redis maxmemory-policy; make sure it is "noeviction".');
  }

  // Minimal ops server for the worker: /health and /metrics, both behind X-Ops-Token.
  const metrics = app.get(MetricsService);
  const server = createServer((req, res) => {
    if (!isValidOpsToken(req.headers['x-ops-token'], config.OPS_TOKEN)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'Missing or invalid X-Ops-Token' }));
      return;
    }
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }
    if (req.url === '/metrics') {
      void metrics.registry.metrics().then((body) => {
        res.writeHead(200, { 'content-type': metrics.registry.contentType });
        res.end(body);
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(config.WORKER_PORT, () => logger.log(`Worker ops server on :${config.WORKER_PORT}`));

  app.enableShutdownHooks();
  const shutdown = () => server.close();
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

void bootstrap();
