import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { API_KEY_PATTERN } from '../api-keys/api-keys.service.js';
import { hashToken } from '../auth/auth.service.js';

export interface ApiKeyContext {
  id: string;
  name: string;
  rateLimitPerMinute: number;
}

export type ApiRequest = Request & { apiKey?: ApiKeyContext };

const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Authenticates `Authorization: Bearer wbk_...` (T186): hash lookup, revoked keys refused. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const presented = match?.[1];
    if (!presented || !API_KEY_PATTERN.test(presented)) throw AppError.unauthorized('Missing or invalid API key');

    const key = await this.prisma.apiKey.findUnique({ where: { keyHash: hashToken(presented) } });
    if (!key || key.revokedAt) throw AppError.unauthorized('The API key is invalid or has been revoked');
    req.apiKey = { id: key.id, name: key.name, rateLimitPerMinute: key.rateLimitPerMinute };
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
      await this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    }
    return true;
  }
}
