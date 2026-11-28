import type { Response } from 'express';
import { SESSION_ABSOLUTE_MS, newRandomToken } from './auth.service.js';
import { PENDING_SECONDS } from './two-factor.service.js';

export const SESSION_COOKIE = 'sid';
export const CSRF_COOKIE = 'csrf';
export const CSRF_HEADER = 'x-csrf-token';
/** Feature 010 (US6): a pending sign-in between the password and the second step (contracts/login-2fa.md §1). */
export const PENDING_COOKIE = 'sid_2fa';

export function setPendingCookie(res: Response, token: string, secure: boolean): void {
  res.cookie(PENDING_COOKIE, token, { httpOnly: true, sameSite: 'strict', secure, path: '/', maxAge: PENDING_SECONDS * 1000 });
}

export function clearPendingCookie(res: Response, secure: boolean): void {
  res.clearCookie(PENDING_COOKIE, { httpOnly: true, sameSite: 'strict', secure, path: '/' });
}

/** httpOnly session cookie + readable CSRF cookie for the double-submit check (ADR-0005). */
export function setAuthCookies(res: Response, sessionToken: string, secure: boolean): void {
  const common = { secure, sameSite: 'lax' as const, path: '/', maxAge: SESSION_ABSOLUTE_MS };
  res.cookie(SESSION_COOKIE, sessionToken, { ...common, httpOnly: true });
  res.cookie(CSRF_COOKIE, newRandomToken(24), { ...common, httpOnly: false });
}

export function clearAuthCookies(res: Response, secure: boolean): void {
  const common = { secure, sameSite: 'lax' as const, path: '/' };
  res.clearCookie(SESSION_COOKIE, { ...common, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, common);
}
