import {
  Injectable,
  SetMetadata,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { can } from '@wbm/shared';
import { map, type Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/request-user.js';
import { maskPhone } from '../phone/phone.js';

export const PHONE_FIELDS = 'wbm:phoneFields';
export const DEFAULT_PHONE_FIELDS = ['phone', 'phoneE164'];

/** Declares which response properties hold phone numbers (defaults to `phone`, `phoneE164`). */
export const PhoneField = (...keys: string[]) =>
  SetMetadata(PHONE_FIELDS, keys.length ? keys : DEFAULT_PHONE_FIELDS);

/** Returns a copy with the given keys masked to the last 4 digits. */
export function maskPhoneFields(value: unknown, keys: ReadonlySet<string>, depth = 0): unknown {
  if (depth > 10 || value === null || typeof value !== 'object' || value instanceof Date) return value;
  if (Array.isArray(value)) return value.map((item) => maskPhoneFields(item, keys, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    out[key] =
      keys.has(key) && typeof inner === 'string' ? maskPhone(inner) : maskPhoneFields(inner, keys, depth + 1);
  }
  return out;
}

/**
 * Global interceptor: users without `phones.full` (agents) only ever receive masked numbers
 * (FR-007, T049). Masking is centralised so no endpoint can forget it.
 */
@Injectable()
export class PhoneMaskInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const user = context.switchToHttp().getRequest<AuthedRequest>().user;
    if (!user || can(user.role, 'phones.full')) return next.handle();
    const keys = new Set(
      this.reflector.getAllAndOverride<string[] | undefined>(PHONE_FIELDS, [context.getHandler(), context.getClass()]) ??
        DEFAULT_PHONE_FIELDS,
    );
    return next.handle().pipe(map((body: unknown) => maskPhoneFields(body, keys)));
  }
}
