import { timingSafeEqual } from 'node:crypto';
import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG } from '../config/config.module.js';
import type { AppConfig } from '../config/config.js';
import { AppError } from '../errors/app-error.js';

/** Timing-safe comparison of the X-Ops-Token header with OPS_TOKEN (constitution Principle III). */
export function isValidOpsToken(header: string | string[] | undefined, expected: string): boolean {
  if (typeof header !== 'string' || !expected) return false;
  const given = Buffer.from(header);
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

/** Protects /api/health and /metrics. */
@Injectable()
export class OpsTokenGuard implements CanActivate {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    if (!isValidOpsToken(req.headers['x-ops-token'], this.config.OPS_TOKEN)) {
      throw AppError.unauthorized('Missing or invalid X-Ops-Token');
    }
    return true;
  }
}
