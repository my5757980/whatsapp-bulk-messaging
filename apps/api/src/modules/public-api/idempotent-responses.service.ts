import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { requestHash } from './idempotency.service.js';

// Idempotency for the changing public API routes of feature 006 (FR-015), with the 001 rules: the
// same Idempotency-Key and the same request within 24 hours get the first answer again; the same
// key with a different request is a conflict. Message sends keep their own 001 records.

const TTL_MS = 24 * 3600 * 1000;

export interface Answer<T> {
  status: number;
  body: T;
}

@Injectable()
export class IdempotentResponses {
  constructor(private readonly prisma: PrismaService) {}

  async run<T>(apiKeyId: string, key: string | undefined, request: { method: string; path: string; body: unknown }, work: () => Promise<Answer<T>>): Promise<Answer<T>> {
    const idempotencyKey = key?.trim();
    if (!idempotencyKey) return work();
    if (idempotencyKey.length > 255) throw AppError.validation('The Idempotency-Key is too long', [{ field: 'Idempotency-Key', issue: 'must be at most 255 characters' }]);
    const hash = requestHash(request);
    const saved = await this.prisma.apiIdempotentResponse.findUnique({ where: { apiKeyId_key: { apiKeyId, key: idempotencyKey } } });
    if (saved && saved.expiresAt.getTime() > Date.now()) {
      if (saved.requestHash !== hash) throw AppError.conflict('This Idempotency-Key was used for a different request', 'IDEMPOTENCY_KEY_REUSED');
      return { status: saved.status, body: (saved.status === 204 ? undefined : saved.body) as T };
    }
    if (saved) await this.prisma.apiIdempotentResponse.deleteMany({ where: { id: saved.id } });

    const answer = await work();
    // Only answers that changed something are kept; errors can be retried with the same key.
    if (answer.status < 300) {
      try {
        await this.prisma.apiIdempotentResponse.create({
          data: { apiKeyId, key: idempotencyKey, requestHash: hash, status: answer.status, body: (answer.body ?? {}) as Prisma.InputJsonValue, expiresAt: new Date(Date.now() + TTL_MS) },
        });
      } catch (error) {
        // A parallel request with the same key saved its answer first; ours is still correct.
        if (!isUniqueViolation(error)) throw error;
      }
    }
    return answer;
  }

  /** Hourly, with the 001 records: drops expired answers. */
  async cleanup(): Promise<number> {
    const { count } = await this.prisma.apiIdempotentResponse.deleteMany({ where: { expiresAt: { lt: new Date() } } });
    return count;
  }
}
