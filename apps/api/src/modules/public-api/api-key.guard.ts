import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SCOPE_LABELS, effectiveScopes, hasScope, type ApiKeyScope } from '@wbm/shared';
import type { Request } from 'express';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { API_KEY_PATTERN } from '../api-keys/api-keys.service.js';
import { hashToken } from '../auth/auth.service.js';
import { API_SCOPE } from './api-scope.decorator.js';

export interface ApiKeyContext {
  id: string;
  name: string;
  rateLimitPerMinute: number;
  /** What the key may do (feature 006, FR-010). */
  scopes: ApiKeyScope[];
}

export type ApiRequest = Request & { apiKey?: ApiKeyContext };

const LAST_USED_WRITE_INTERVAL_MS = 60_000;

/** Authenticates `Authorization: Bearer wbk_...` (T186): hash lookup, revoked keys refused. */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<ApiRequest>();
    const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
    const presented = match?.[1];
    if (!presented || !API_KEY_PATTERN.test(presented)) throw AppError.unauthorized('Missing or invalid API key');

    const key = await this.prisma.apiKey.findUnique({ where: { keyHash: hashToken(presented) } });
    if (!key || key.revokedAt) throw AppError.unauthorized('The API key is invalid or has been revoked');
    // The route's permission (feature 006): keys made before 006 can only send messages.
    const needed = this.reflector.getAllAndOverride<ApiKeyScope | undefined>(API_SCOPE, [context.getHandler(), context.getClass()]);
    if (needed && !hasScope(key.scopes, needed)) {
      throw new AppError(HttpStatus.FORBIDDEN, 'insufficient_scope', `This API key may not ${SCOPE_LABELS[needed].toLowerCase()} (it needs the ${needed} permission)`);
    }
    req.apiKey = { id: key.id, name: key.name, rateLimitPerMinute: key.rateLimitPerMinute, scopes: effectiveScopes(key.scopes) };
    if (!key.lastUsedAt || Date.now() - key.lastUsedAt.getTime() > LAST_USED_WRITE_INTERVAL_MS) {
      await this.prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
    }
    return true;
  }
}
