import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { Role } from '@wbm/shared';
import type { Request } from 'express';

export interface RequestUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

export type AuthedRequest = Request & {
  id?: string;
  user?: RequestUser;
  sessionTokenHash?: string;
};

/** Injects the signed-in user (set by SessionGuard). */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestUser | undefined => {
  return ctx.switchToHttp().getRequest<AuthedRequest>().user;
});

export function clientIp(req: Request): string | undefined {
  return req.ip ?? req.socket?.remoteAddress ?? undefined;
}
