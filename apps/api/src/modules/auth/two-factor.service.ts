import { createHash } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import QRCode from 'qrcode';
import { otpauthUrl, newTotpSecret, verifyTotp } from '../../common/auth/totp.js';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { TokenCipher } from '../../common/crypto/token-cipher.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { AuthService, newRandomToken } from './auth.service.js';
import { hashRecoveryCode, newRecoveryCodes } from './recovery-codes.js';
import { MetricsService } from '../../common/metrics/metrics.service.js';

// Feature 010 (US6, research R10, contracts/login-2fa.md): authenticator-app codes with recovery codes, the
// pending sign-in between the password and the code, the lockout, self-service and admin resets.
// Codes, secrets and recovery codes never reach logs, audit details or errors.

export type SecondStep = 'CODE' | 'SETUP';
export interface PendingSignIn {
  userId: string;
  next: SecondStep;
  ip: string | null;
}

/** A pending sign-in lives 5 minutes; 5 wrong codes in a row lock the second step for 15 minutes. */
export const PENDING_SECONDS = 5 * 60;
export const MAX_FAILURES = 5;
export const LOCK_SECONDS = 15 * 60;

const pendingKey = (token: string) => `wbm:login2fa:${createHash('sha256').update(token).digest('hex')}`;
const failKey = (userId: string) => `wbm:login2fa:fail:${userId}`;
const lockKey = (userId: string) => `wbm:login2fa:lock:${userId}`;

@Injectable()
export class TwoFactorService {
  private readonly hashKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: TokenCipher,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly metrics: MetricsService,
  ) {
    this.hashKey = Buffer.from(config.TOKEN_ENCRYPTION_KEY, 'base64');
  }

  /** Whether the company requires 2FA. */
  async required(): Promise<boolean> {
    const row = await this.prisma.settings.upsert({ where: { id: 1 }, create: { id: 1 }, update: {}, select: { require2fa: true } });
    return row.require2fa;
  }

  private async enabledRow(userId: string) {
    const row = await this.prisma.userTwoFactor.findUnique({ where: { userId } });
    return row?.enabledAt ? row : null;
  }

  /** The step a member still needs after the password, if any. */
  async secondStep(userId: string): Promise<SecondStep | null> {
    if (await this.enabledRow(userId)) return 'CODE';
    return (await this.required()) ? 'SETUP' : null;
  }

  async status(userId: string) {
    const [row, required, left] = await Promise.all([
      this.enabledRow(userId),
      this.required(),
      this.prisma.userRecoveryCode.count({ where: { userId, usedAt: null } }),
    ]);
    return { enabled: Boolean(row), enabledAt: row?.enabledAt?.toISOString() ?? null, required, recoveryCodesLeft: row ? left : 0 };
  }

  // ---- pending sign-in -------------------------------------------------------------------------------------

  async createPending(userId: string, next: SecondStep, ip: string | null): Promise<string> {
    const token = newRandomToken();
    await this.redis.set(pendingKey(token), JSON.stringify({ userId, next, ip } satisfies PendingSignIn), 'EX', PENDING_SECONDS);
    return token;
  }

  /** The pending sign-in behind a cookie with the expected next step, or 401 PENDING_SIGN_IN_EXPIRED. */
  async pending(token: string | undefined, next: SecondStep): Promise<PendingSignIn> {
    const raw = token ? await this.redis.get(pendingKey(token)) : null;
    const value = raw ? (JSON.parse(raw) as PendingSignIn) : null;
    if (!value || value.next !== next) throw new AppError(HttpStatus.UNAUTHORIZED, 'PENDING_SIGN_IN_EXPIRED', 'Your sign-in has expired. Sign in again.');
    return value;
  }

  async endPending(token: string): Promise<void> {
    await this.redis.del(pendingKey(token));
  }

  // ---- lockout ---------------------------------------------------------------------------------------------

  /** Seconds left on the lock, or 0. */
  async lockedFor(userId: string): Promise<number> {
    const ttl = await this.redis.ttl(lockKey(userId));
    return ttl > 0 ? ttl : 0;
  }

  async assertNotLocked(userId: string): Promise<void> {
    if (await this.lockedFor(userId)) throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'SECOND_STEP_LOCKED', 'Too many wrong codes. Try again in 15 minutes.');
  }

  /** Counts a wrong code; the fifth in a row locks the second step and ends the pending sign-in. */
  async recordFailure(userId: string, actor: AuditActor, pendingToken?: string): Promise<never> {
    const count = await this.redis.incr(failKey(userId));
    if (count === 1) await this.redis.expire(failKey(userId), LOCK_SECONDS);
    await this.audit.record(actor, 'auth.2fa_failed', { type: 'user', id: userId }, { failures: count });
    this.metrics.loginSecondStepTotal.inc({ result: 'failed' });
    if (count >= MAX_FAILURES) {
      await this.redis.set(lockKey(userId), '1', 'EX', LOCK_SECONDS);
      await this.redis.del(failKey(userId));
      if (pendingToken) await this.endPending(pendingToken);
      await this.audit.record(actor, 'auth.2fa_locked', { type: 'user', id: userId }, { minutes: LOCK_SECONDS / 60 });
      this.metrics.loginSecondStepTotal.inc({ result: 'locked' });
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'SECOND_STEP_LOCKED', 'Too many wrong codes. Try again in 15 minutes.');
    }
    throw AppError.validation('That code is not right', [{ field: 'code', issue: 'is not valid' }], 'INVALID_CODE');
  }

  /** A second step that signed the member in. */
  signedIn(step: 'CODE' | 'RECOVERY' | 'SETUP'): void {
    this.metrics.loginSecondStepTotal.inc({ result: step.toLowerCase() });
  }

  async clearFailures(userId: string): Promise<void> {
    await this.redis.del(failKey(userId));
  }

  // ---- codes -----------------------------------------------------------------------------------------------

  /** Checks an app code against the member's enabled secret and records its step (never accepted twice). */
  async checkCode(userId: string, code: string): Promise<boolean> {
    const row = await this.enabledRow(userId);
    if (!row) return false;
    const last = row.lastStep === null ? null : Number(row.lastStep);
    const step = verifyTotp(this.cipher.decrypt(row.secretEnc), code, Date.now(), last);
    if (step === null) return false;
    // Conditional, so two requests with the same code cannot both pass.
    const { count } = await this.prisma.userTwoFactor.updateMany({
      where: { userId, OR: [{ lastStep: null }, { lastStep: { lt: BigInt(step) } }] },
      data: { lastStep: BigInt(step) },
    });
    return count === 1;
  }

  /** Uses a recovery code once; returns how many are left, or null when it does not match. */
  async useRecoveryCode(userId: string, code: string, actor: AuditActor): Promise<number | null> {
    if (!(await this.enabledRow(userId))) return null;
    const { count } = await this.prisma.userRecoveryCode.updateMany({ where: { userId, codeHash: hashRecoveryCode(this.hashKey, code), usedAt: null }, data: { usedAt: new Date() } });
    if (!count) return null;
    const left = await this.prisma.userRecoveryCode.count({ where: { userId, usedAt: null } });
    await this.audit.record(actor, 'auth.2fa_recovery_used', { type: 'user', id: userId }, { left });
    return left;
  }

  private async replaceRecoveryCodes(userId: string): Promise<string[]> {
    const codes = newRecoveryCodes();
    await this.prisma.$transaction([
      this.prisma.userRecoveryCode.deleteMany({ where: { userId } }),
      this.prisma.userRecoveryCode.createMany({ data: codes.map((c) => ({ userId, codeHash: hashRecoveryCode(this.hashKey, c) })) }),
    ]);
    return codes;
  }

  // ---- setup and self-service ------------------------------------------------------------------------------

  /** A new secret (not enabled yet); replaces an unconfirmed one. */
  async startSetup(userId: string) {
    if (await this.enabledRow(userId)) throw AppError.conflict('Two-factor sign-in is already on', 'ALREADY_ENABLED');
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
    const secret = newTotpSecret();
    const secretEnc = this.cipher.encrypt(secret);
    await this.prisma.userTwoFactor.upsert({ where: { userId }, create: { userId, secretEnc }, update: { secretEnc, enabledAt: null, lastStep: null } });
    const url = otpauthUrl(this.config.APP_NAME, user.email, secret);
    return { secret, otpauthUrl: url, qrSvg: await QRCode.toString(url, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }) };
  }

  /** Confirms the pending secret with a code: 2FA on, 10 recovery codes returned once. */
  async confirmSetup(userId: string, code: string, actor: AuditActor, pendingToken?: string): Promise<{ recoveryCodes: string[] }> {
    const row = await this.prisma.userTwoFactor.findUnique({ where: { userId } });
    if (!row) throw AppError.conflict('Start the setup first', 'NO_SETUP');
    if (row.enabledAt) throw AppError.conflict('Two-factor sign-in is already on', 'ALREADY_ENABLED');
    await this.assertNotLocked(userId);
    const step = verifyTotp(this.cipher.decrypt(row.secretEnc), code, Date.now());
    if (step === null) return this.recordFailure(userId, actor, pendingToken);
    const { count } = await this.prisma.userTwoFactor.updateMany({ where: { userId, enabledAt: null }, data: { enabledAt: new Date(), lastStep: BigInt(step) } });
    if (!count) throw AppError.conflict('Two-factor sign-in is already on', 'ALREADY_ENABLED');
    await this.clearFailures(userId);
    const recoveryCodes = await this.replaceRecoveryCodes(userId);
    await this.audit.record(actor, 'auth.2fa_enabled', { type: 'user', id: userId });
    return { recoveryCodes };
  }

  /** Turns 2FA off with a current code; refused while the company requires it. */
  async disable(userId: string, code: string, actor: AuditActor): Promise<void> {
    if (!(await this.enabledRow(userId))) throw AppError.conflict('Two-factor sign-in is not on', 'NOT_ENABLED');
    if (await this.required()) throw AppError.conflict('Your company requires two-factor sign-in', 'TWO_FACTOR_REQUIRED');
    await this.assertNotLocked(userId);
    if (!(await this.checkCode(userId, code))) return this.recordFailure(userId, actor);
    await this.clearFailures(userId);
    await this.prisma.$transaction([this.prisma.userRecoveryCode.deleteMany({ where: { userId } }), this.prisma.userTwoFactor.deleteMany({ where: { userId } })]);
    await this.audit.record(actor, 'auth.2fa_disabled', { type: 'user', id: userId });
  }

  /** New recovery codes with a current code; the old ones stop working. */
  async regenerate(userId: string, code: string, actor: AuditActor): Promise<{ recoveryCodes: string[] }> {
    if (!(await this.enabledRow(userId))) throw AppError.conflict('Two-factor sign-in is not on', 'NOT_ENABLED');
    await this.assertNotLocked(userId);
    if (!(await this.checkCode(userId, code))) return this.recordFailure(userId, actor);
    await this.clearFailures(userId);
    const recoveryCodes = await this.replaceRecoveryCodes(userId);
    await this.audit.record(actor, 'auth.2fa_recovery_regenerated', { type: 'user', id: userId });
    return { recoveryCodes };
  }

  // ---- admins ----------------------------------------------------------------------------------------------

  /** Deletes a member's secret and codes and ends their sessions (an admin, or the operator script). */
  async reset(userId: string, actor: AuditActor, by: 'admin' | 'operator' = 'admin'): Promise<void> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!user) throw AppError.notFound('Member not found');
    if (by === 'admin' && actor.userId === userId) throw AppError.conflict('You cannot reset your own two-factor sign-in', 'CANNOT_RESET_SELF');
    await this.prisma.$transaction([this.prisma.userRecoveryCode.deleteMany({ where: { userId } }), this.prisma.userTwoFactor.deleteMany({ where: { userId } })]);
    await this.auth.revokeAllSessions(userId);
    await this.redis.del(failKey(userId), lockKey(userId));
    await this.audit.record(actor, 'auth.2fa_reset', { type: 'user', id: userId }, { by });
  }

  async securitySettings() {
    const [required, users] = await Promise.all([
      this.required(),
      this.prisma.user.findMany({
        where: { status: { not: 'DEACTIVATED' } },
        select: { id: true, name: true, email: true, role: true, twoFactor: { select: { enabledAt: true } } },
        orderBy: { email: 'asc' },
      }),
    ]);
    return {
      require2fa: required,
      members: users.map((u) => ({ userId: u.id, name: u.name, email: u.email, role: u.role, twoFactorEnabled: Boolean(u.twoFactor?.enabledAt) })),
    };
  }

  async setRequired(require2fa: boolean, actor: AuditActor) {
    const before = await this.required();
    await this.prisma.settings.update({ where: { id: 1 }, data: { require2fa } });
    if (before !== require2fa) await this.audit.record(actor, 'security.2fa_required_changed', { type: 'settings', id: '1' }, { require2fa });
    return this.securitySettings();
  }
}
