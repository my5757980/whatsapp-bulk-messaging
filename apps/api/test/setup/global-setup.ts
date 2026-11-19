import { execSync } from 'node:child_process';
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { Redis } from 'ioredis';
import '../../src/common/config/load-env.js';

/** Creates the object-storage bucket when missing (CI starts an empty MinIO; the API does this at boot). */
async function ensureBucket(): Promise<void> {
  const bucket = process.env.S3_BUCKET ?? 'wbm';
  const s3 = new S3Client({
    region: process.env.S3_REGION ?? 'us-east-1',
    ...(process.env.S3_ENDPOINT ? { endpoint: process.env.S3_ENDPOINT, forcePathStyle: true } : {}),
    ...(process.env.S3_ACCESS_KEY && process.env.S3_SECRET_KEY
      ? { credentials: { accessKeyId: process.env.S3_ACCESS_KEY, secretAccessKey: process.env.S3_SECRET_KEY } }
      : {}),
  });
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  } finally {
    s3.destroy();
  }
}

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

  await ensureBucket();
}
