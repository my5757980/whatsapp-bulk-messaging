import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/common/config/config.js';
import { StorageService } from '../../src/common/storage/storage.service.js';

// T040: object storage round trip against the local S3-compatible server (MinIO).
describe('StorageService', () => {
  const storage = new StorageService(loadConfig());

  it('creates the bucket when missing and is idempotent', async () => {
    expect(['exists', 'created']).toContain(await storage.ensureBucket());
    expect(await storage.ensureBucket()).toBe('exists');
  });

  it('puts, reads back and deletes an object', async () => {
    const key = `tests/${randomUUID()}.csv`;
    await storage.put(key, Buffer.from('phone,name\n+971501234567,Sara\n'), 'text/csv');
    expect((await storage.getBuffer(key)).toString()).toContain('+971501234567,Sara');
    await storage.delete(key);
    await expect(storage.getBuffer(key)).rejects.toThrow();
  });
});
