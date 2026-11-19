import { timingSafeEqual } from 'node:crypto';
import { HttpStatus, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { CSRF_COOKIE, CSRF_HEADER } from '../../modules/auth/auth.cookies.js';
import { AppError } from '../errors/app-error.js';
import { IS_PUBLIC } from './public.decorator.js';
import type { AuthedRequest } from './request-user.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Double-submit CSRF check on every mutating, non-public request (T046, ADR-0005). */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (SAFE_METHODS.has(req.method.toUpperCase())) return true;

    const cookie = (req.cookies as Record<string, string | undefined> | undefined)?.[CSRF_COOKIE];
    const header = req.headers[CSRF_HEADER];
    const ok =
      typeof cookie === 'string' &&
      typeof header === 'string' &&
      cookie.length > 0 &&
      cookie.length === header.length &&
      timingSafeEqual(Buffer.from(cookie), Buffer.from(header));
    if (!ok) throw new AppError(HttpStatus.FORBIDDEN, 'CSRF_FAILED', 'Missing or invalid CSRF token');
    return true;
  }
}
