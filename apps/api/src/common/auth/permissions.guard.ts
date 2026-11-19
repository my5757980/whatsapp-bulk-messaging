import { Injectable, SetMetadata, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can, type Permission } from '@wbm/shared';
import { AppError } from '../errors/app-error.js';
import type { AuthedRequest } from './request-user.js';

export const REQUIRED_PERMISSIONS = 'wbm:requiredPermissions';

/** Declares the permission(s) a route needs; mirrors `x-permission` in the OpenAPI contract. */
export const Require = (...permissions: Permission[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

/** Global guard enforcing the shared role -> permission matrix (FR-006, T047). */
@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(REQUIRED_PERMISSIONS, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;
    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || !required.every((p) => can(user.role, p))) throw AppError.forbidden();
    return true;
  }
}
