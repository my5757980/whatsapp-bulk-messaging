import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';
import { permissionsFor, type Role } from '@wbm/shared';
import type { User } from '../../generated/prisma/client.js';
import type { RequestUser } from '../../common/auth/request-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';

export const SESSION_ABSOLUTE_MS = 7 * 24 * 3600 * 1000;
export const SESSION_IDLE_MS = 12 * 3600 * 1000;
const LAST_SEEN_WRITE_INTERVAL_MS = 60 * 1000;

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newRandomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function toPublicUser(user: Pick<User, 'id' | 'email' | 'name' | 'role' | 'status' | 'lastLoginAt'>) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
  };
}

export interface LoginResult {
  user: User;
  sessionToken: string;
}

/** Email/password sign-in with opaque, DB-backed sessions (research R14, ADR-0005, T043). */
@Injectable()
export class AuthService {
  constructor(private readonly prisma: PrismaService) {}

  static normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  hashPassword(password: string): Promise<string> {
    return argon2.hash(password, { type: argon2.argon2id });
  }

  async login(email: string, password: string, meta: { ip?: string; userAgent?: string }): Promise<LoginResult> {
    const user = await this.prisma.user.findUnique({ where: { email: AuthService.normalizeEmail(email) } });
    const valid =
      user?.status === 'ACTIVE' && user.passwordHash !== null && (await argon2.verify(user.passwordHash, password));
    if (!user || !valid) {
      throw AppError.unauthorized('Invalid email or password');
    }

    const sessionToken = newRandomToken();
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.session.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(sessionToken),
          expiresAt: new Date(now.getTime() + SESSION_ABSOLUTE_MS),
          lastSeenAt: now,
          ip: meta.ip ?? null,
          userAgent: meta.userAgent?.slice(0, 300) ?? null,
        },
      }),
      this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: now } }),
    ]);
    return { user: { ...user, lastLoginAt: now }, sessionToken };
  }

  /** Returns the session's user, or null when missing, expired (idle/absolute) or deactivated. */
  async validateSession(sessionToken: string): Promise<RequestUser | null> {
    const tokenHash = hashToken(sessionToken);
    const session = await this.prisma.session.findUnique({ where: { tokenHash }, include: { user: true } });
    if (!session) return null;

    const now = Date.now();
    const expired = session.expiresAt.getTime() <= now || session.lastSeenAt.getTime() + SESSION_IDLE_MS <= now;
    if (expired || session.user.status !== 'ACTIVE') {
      await this.prisma.session.deleteMany({ where: { id: session.id } });
      return null;
    }

    if (now - session.lastSeenAt.getTime() > LAST_SEEN_WRITE_INTERVAL_MS) {
      await this.prisma.session.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } });
    }
    const { id, email, name, role } = session.user;
    return { id, email, name, role };
  }

  async logout(sessionToken: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { tokenHash: hashToken(sessionToken) } });
  }

  async revokeAllSessions(userId: string): Promise<void> {
    await this.prisma.session.deleteMany({ where: { userId } });
  }

  permissions(role: Role) {
    return permissionsFor(role);
  }
}
