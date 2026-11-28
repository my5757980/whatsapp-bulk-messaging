import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { permissionsFor } from '@wbm/shared';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Public } from '../../common/auth/public.decorator.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { AuditService } from '../audit/audit.service.js';
import { PENDING_COOKIE, SESSION_COOKIE, clearAuthCookies, clearPendingCookie, setAuthCookies, setPendingCookie } from './auth.cookies.js';
import { AuthService, toPublicUser } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';
import { CodeInputSchema } from './two-factor.controller.js';
import { LOCK_SECONDS, TwoFactorService } from './two-factor.service.js';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
type LoginBody = z.infer<typeof LoginSchema>;
/** Feature 010 (US6): an app code or a recovery code (case, spaces and dashes ignored). */
const LoginCodeSchema = z.union([z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), z.object({ recoveryCode: z.string().trim().min(10).max(11) }).strict()]);
type LoginCodeBody = z.infer<typeof LoginCodeSchema>;
type Meta = { ip?: string; userAgent?: string };
const metaOf = (req: Request): Meta => ({ ...(clientIp(req) ? { ip: clientIp(req) } : {}), ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}) });

/** POST /auth/login, POST /auth/logout, GET /auth/me (dashboard-api.openapi.yaml, T045). */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly twoFactor: TwoFactorService,
  ) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(LoginSchema)) body: LoginBody,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    const email = AuthService.normalizeEmail(body.email);
    const ip = clientIp(req);
    await this.throttle.assertAllowed(email, ip);
    try {
      const verified = await this.auth.verifyPassword(email, body.password);
      await this.throttle.reset(email, ip);
      // Feature 010 (US6): a member with 2FA, or who must set it up, gets a pending sign-in, never a session.
      const next = await this.twoFactor.secondStep(verified.id);
      if (next) {
        setPendingCookie(res, await this.twoFactor.createPending(verified.id, next, ip ?? null), this.config.COOKIE_SECURE);
        return { next };
      }
      const { user, sessionToken } = await this.auth.createSession(verified, metaOf(req));
      setAuthCookies(res, sessionToken, this.config.COOKIE_SECURE);
      await this.audit.record({ userId: user.id, ip: ip ?? null }, 'auth.login', { type: 'user', id: user.id });
      return toPublicUser(user);
    } catch (error) {
      if (error instanceof AppError && error.status === 401) {
        await this.throttle.recordFailure(email, ip);
        await this.audit.record({ ip: ip ?? null }, 'auth.login_failed', { type: 'user' }, { email });
      }
      throw error;
    }
  }

  /** Feature 010 (US6, contracts/login-2fa.md §3): the second step with an app code or a recovery code. */
  @Post('login/code')
  @Public()
  @HttpCode(200)
  async loginCode(@Body(new ZodValidationPipe(LoginCodeSchema)) body: LoginCodeBody, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[PENDING_COOKIE];
    const pending = await this.twoFactor.pending(token, 'CODE');
    const actor = { userId: pending.userId, ip: clientIp(req) ?? null };
    return this.withLockHeader(res, pending.userId, async () => {
      await this.twoFactor.assertNotLocked(pending.userId);
      let left: number | null = null;
      if ('code' in body) {
        if (!(await this.twoFactor.checkCode(pending.userId, body.code))) return this.twoFactor.recordFailure(pending.userId, actor, token);
      } else {
        left = await this.twoFactor.useRecoveryCode(pending.userId, body.recoveryCode, actor);
        if (left === null) return this.twoFactor.recordFailure(pending.userId, actor, token);
      }
      const user = await this.finishSecondStep(token!, pending.userId, req, res, 'code' in body ? 'CODE' : 'RECOVERY');
      return { ...toPublicUser(user), ...(left !== null ? { recoveryCodesLeft: left } : {}) };
    });
  }

  /** Feature 010 (US6, §4): the secret for a member who must set up 2FA before signing in. */
  @Post('login/setup')
  @Public()
  @HttpCode(200)
  async loginSetup(@Req() req: Request) {
    const pending = await this.twoFactor.pending((req.cookies as Record<string, string | undefined> | undefined)?.[PENDING_COOKIE], 'SETUP');
    return this.twoFactor.startSetup(pending.userId);
  }

  /** Feature 010 (US6, §4): confirms the required setup, signs in and returns the recovery codes once. */
  @Post('login/setup/confirm')
  @Public()
  @HttpCode(200)
  async loginSetupConfirm(@Body(new ZodValidationPipe(CodeInputSchema)) body: { code: string }, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[PENDING_COOKIE];
    const pending = await this.twoFactor.pending(token, 'SETUP');
    return this.withLockHeader(res, pending.userId, async () => {
      const { recoveryCodes } = await this.twoFactor.confirmSetup(pending.userId, body.code, { userId: pending.userId, ip: clientIp(req) ?? null }, token);
      await this.finishSecondStep(token!, pending.userId, req, res, 'SETUP');
      return { recoveryCodes };
    });
  }

  /** Ends the pending sign-in and creates the session (the 001 cookies and the auth.login audit). */
  private async finishSecondStep(token: string, userId: string, req: Request, res: Response, secondStep: 'CODE' | 'RECOVERY' | 'SETUP') {
    await this.twoFactor.clearFailures(userId);
    await this.twoFactor.endPending(token);
    clearPendingCookie(res, this.config.COOKIE_SECURE);
    const member = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (member.status !== 'ACTIVE') throw AppError.unauthorized('Invalid email or password');
    const { user, sessionToken } = await this.auth.createSession(member, metaOf(req));
    setAuthCookies(res, sessionToken, this.config.COOKIE_SECURE);
    await this.audit.record({ userId, ip: clientIp(req) ?? null }, 'auth.login', { type: 'user', id: userId }, { secondStep });
    this.twoFactor.signedIn(secondStep);
    return user;
  }

  /** A locked second step answers 429 with Retry-After. */
  private async withLockHeader<T>(res: Response, userId: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (error instanceof AppError && error.code === 'SECOND_STEP_LOCKED') {
        res.setHeader('Retry-After', String((await this.twoFactor.lockedFor(userId)) || LOCK_SECONDS));
        clearPendingCookie(res, this.config.COOKIE_SECURE);
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response): Promise<void> {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[SESSION_COOKIE];
    if (token) await this.auth.logout(token);
    clearAuthCookies(res, this.config.COOKIE_SECURE);
    await this.audit.record({ userId: req.user?.id ?? null, ip: clientIp(req) ?? null }, 'auth.logout', {
      type: 'user',
      id: req.user?.id ?? null,
    });
  }

  @Get('me')
  async me(@CurrentUser() current: RequestUser) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: current.id } });
    return { ...toPublicUser(user), permissions: permissionsFor(user.role) };
  }
}
