import { Global, Injectable, Module } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';

import type { AuditAction } from './audit-actions.js';

export type { AuditAction } from './audit-actions.js';

export interface AuditActor {
  userId?: string | null;
  apiKeyId?: string | null;
  ip?: string | null;
}

export interface AuditTarget {
  type: string;
  id?: string | null;
}

type Db = Pick<PrismaService, 'auditLog'> | Prisma.TransactionClient;

/** Writes security-relevant actions to audit_logs (FR-008, T050). Never pass secrets in metadata. */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(
    actor: AuditActor,
    action: AuditAction,
    target: AuditTarget,
    metadata: Record<string, unknown> = {},
    db: Db = this.prisma,
  ): Promise<void> {
    await db.auditLog.create({
      data: {
        actorUserId: actor.userId ?? null,
        actorApiKeyId: actor.apiKeyId ?? null,
        ip: actor.ip ?? null,
        action,
        targetType: target.type,
        targetId: target.id ?? null,
        metadata: metadata as Prisma.InputJsonValue,
      },
    });
  }
}

@Global()
@Module({ providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
