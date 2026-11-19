import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SESSION_COOKIE } from '../../modules/auth/auth.cookies.js';
import { AuthService, hashToken } from '../../modules/auth/auth.service.js';
import { AppError } from '../errors/app-error.js';
import { IS_PUBLIC } from './public.decorator.js';
import type { AuthedRequest } from './request-user.js';

/** Global guard: every non-public route needs a valid, active session (T046). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()])) {
      return true;
    }
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    const user = token ? await this.auth.validateSession(token) : null;
    if (!user || !token) throw AppError.unauthorized();
    req.user = user;
    req.sessionTokenHash = hashToken(token);
    return true;
  }
}
