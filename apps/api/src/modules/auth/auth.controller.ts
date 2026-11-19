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
import { SESSION_COOKIE, clearAuthCookies, setAuthCookies } from './auth.cookies.js';
import { AuthService, toPublicUser } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

const LoginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
type LoginBody = z.infer<typeof LoginSchema>;

/** POST /auth/login, POST /auth/logout, GET /auth/me (dashboard-api.openapi.yaml, T045). */
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly throttle: LoginThrottleService,
    private readonly audit: AuditService,
    private readonly prisma: PrismaService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
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
      const { user, sessionToken } = await this.auth.login(email, body.password, {
        ...(ip ? { ip } : {}),
        ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
      });
      await this.throttle.reset(email, ip);
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
