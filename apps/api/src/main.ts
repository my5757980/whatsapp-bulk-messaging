import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Redis } from 'ioredis';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { APP_CONFIG } from './common/config/config.module.js';
import { assertRedisNoEviction, type AppConfig } from './common/config/config.js';
import { REDIS_CLIENT } from './common/queue/queue.module.js';
import { StorageService } from './common/storage/storage.service.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, { rawBody: true, bufferLogs: true });
  const logger = app.get(Logger);
  app.useLogger(logger);

  const config = app.get<AppConfig>(APP_CONFIG);
  if ((await assertRedisNoEviction(app.get<Redis>(REDIS_CLIENT))) === 'unverifiable') {
    logger.warn('Could not read Redis maxmemory-policy; make sure it is "noeviction".');
  }

  try {
    await app.get(StorageService).ensureBucket();
  } catch (error) {
    logger.warn({ err: (error as Error).message }, 'Object storage is not reachable; uploads will fail until it is.');
  }

  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(config.API_PORT);
  logger.log(`API listening on http://localhost:${config.API_PORT}/api`);
}

void bootstrap();
