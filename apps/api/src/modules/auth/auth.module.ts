import { Global, Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { CsrfGuard } from '../../common/auth/csrf.guard.js';
import { PermissionsGuard } from '../../common/auth/permissions.guard.js';
import { SessionGuard } from '../../common/auth/session.guard.js';
import { PhoneMaskInterceptor } from '../../common/interceptors/phone-mask.interceptor.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { LoginThrottleService } from './login-throttle.service.js';

/** Global guard order: session -> CSRF -> permissions (ADR-0005). */
@Global()
@Module({
  controllers: [AuthController],
  providers: [
    AuthService,
    LoginThrottleService,
    { provide: APP_GUARD, useClass: SessionGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
    { provide: APP_INTERCEPTOR, useClass: PhoneMaskInterceptor },
  ],
  exports: [AuthService],
})
export class AuthModule {}
