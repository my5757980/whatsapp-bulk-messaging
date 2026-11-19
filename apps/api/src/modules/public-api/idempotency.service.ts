import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';

// Idempotency for POST /api/v1/messages (FR-036, T188): the same Idempotency-Key with the same
// body within 24 h returns the original message; a different body is a conflict.

const TTL_MS = 24 * 3600 * 1000;

/** JSON with object keys sorted, so semantically equal bodies hash the same. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function requestHash(body: unknown): string {
  return createHash('sha256').update(stableStringify(body)).digest('hex');
}

export type IdempotencyHit = { kind: 'replay'; messageId: string; createdAt: Date } | { kind: 'conflict' } | null;

@Injectable()
export class IdempotencyService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(apiKeyId: string, key: string, hash: string): Promise<IdempotencyHit> {
    const record = await this.prisma.idempotencyRecord.findUnique({ where: { apiKeyId_key: { apiKeyId, key } }, include: { message: { select: { createdAt: true } } } });
    if (!record) return null;
    if (record.expiresAt.getTime() <= Date.now()) {
      await this.prisma.idempotencyRecord.deleteMany({ where: { id: record.id } });
      return null;
    }
    return record.requestHash === hash ? { kind: 'replay', messageId: record.messageId, createdAt: record.message.createdAt } : { kind: 'conflict' };
  }

  async remember(tx: Prisma.TransactionClient, apiKeyId: string, key: string, hash: string, messageId: string): Promise<void> {
    await tx.idempotencyRecord.create({ data: { apiKeyId, key, requestHash: hash, messageId, expiresAt: new Date(Date.now() + TTL_MS) } });
  }

  /** Frees a key whose message could not be queued, so a retry with the same key sends. */
  async forget(apiKeyId: string, key: string): Promise<void> {
    await this.prisma.idempotencyRecord.deleteMany({ where: { apiKeyId, key } });
  }

  /** Hourly maintenance job: drop expired records. */
  async cleanup(): Promise<number> {
    const { count } = await this.prisma.idempotencyRecord.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return count;
  }
}
