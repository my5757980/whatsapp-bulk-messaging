import { execSync } from 'node:child_process';
import { Redis } from 'ioredis';
import '../../src/common/config/load-env.js';

/**
 * Runs once before the integration/contract projects:
 * resets the TEST database (never the dev database) and flushes Redis.
 */
export default async function globalSetup(): Promise<void> {
  const testUrl = process.env.DATABASE_URL_TEST;
  if (!testUrl) {
    throw new Error('DATABASE_URL_TEST must be set for integration/contract tests (see .env.example).');
  }
  if (testUrl === process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL_TEST must point to a different database than DATABASE_URL.');
  }
  process.env.DATABASE_URL = testUrl;

  execSync('npx --no-install prisma migrate reset --force', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: testUrl },
  });

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379');
  try {
    await redis.flushdb();
  } finally {
    await redis.quit();
  }
}
