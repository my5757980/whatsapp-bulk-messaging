import { Inject, Injectable } from '@nestjs/common';
import type { Role } from '@wbm/shared';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Invitation } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { AuthService, hashToken, newRandomToken } from '../auth/auth.service.js';
import { MailerService } from './mailer.service.js';

// Invitations (FR-005, T171): users join by invitation only. The link carries a random token;
// only its SHA-256 hash is stored. Links expire after 7 days and work once.

const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;

@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly mailer: MailerService,
    private readonly audit: AuditService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async invite(input: { email: string; role: Role }, actor: AuditActor & { userId: string }) {
    const email = AuthService.normalizeEmail(input.email);
    const existing = await this.prisma.user.findUnique({ where: { email } });
    if (existing && existing.status !== 'INVITED') throw AppError.conflict('A team member with this email already exists');

    const token = newRandomToken(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const user = await this.prisma.$transaction(async (tx) => {
      const invited = existing
        ? await tx.user.update({ where: { id: existing.id }, data: { role: input.role } })
        : await tx.user.create({ data: { email, name: email.split('@')[0] ?? email, role: input.role, status: 'INVITED' } });
      // A new link replaces any earlier, unused one.
      await tx.invitation.updateMany({ where: { email, acceptedAt: null, expiresAt: { gt: now } }, data: { expiresAt: now } });
      await tx.invitation.create({ data: { email, role: input.role, tokenHash: hashToken(token), invitedById: actor.userId, expiresAt } });
      return invited;
    });

    const inviteUrl = `${this.config.APP_URL.replace(/\/$/, '')}/invite/${token}`;
    const inviter = await this.prisma.user.findUnique({ where: { id: actor.userId }, select: { name: true } });
    const emailed = await this.mailer.sendInvitation(email, inviteUrl, { inviterName: inviter?.name ?? 'An admin', role: input.role });
    await this.audit.record(actor, 'user.invited', { type: 'user', id: user.id }, { email, role: input.role, emailed });
    return { inviteUrl, expiresAt: expiresAt.toISOString(), emailed };
  }

  private async findValid(token: string): Promise<Invitation> {
    const invitation = await this.prisma.invitation.findUnique({ where: { tokenHash: hashToken(token) } });
    if (!invitation || invitation.acceptedAt || invitation.expiresAt.getTime() <= Date.now()) {
      throw AppError.notFound('This invitation link is invalid or has expired');
    }
    return invitation;
  }

  /** GET /auth/invitations/{token} */
  async check(token: string) {
    const invitation = await this.findValid(token);
    return { email: invitation.email, role: invitation.role };
  }

  /** POST /auth/invitations/{token}/accept: sets name and password, activates and signs in. */
  async accept(token: string, input: { name: string; password: string }, meta: { ip?: string; userAgent?: string }) {
    const invitation = await this.findValid(token);
    const passwordHash = await this.auth.hashPassword(input.password);
    await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.invitation.updateMany({ where: { id: invitation.id, acceptedAt: null }, data: { acceptedAt: new Date() } });
      const user = await tx.user.findUnique({ where: { email: invitation.email } });
      if (!claimed.count || !user || user.status !== 'INVITED') throw AppError.notFound('This invitation link is invalid or has expired');
      await tx.user.update({ where: { id: user.id }, data: { name: input.name, passwordHash, status: 'ACTIVE', role: invitation.role } });
    });
    const result = await this.auth.login(invitation.email, input.password, meta);
    await this.audit.record({ userId: result.user.id, ip: meta.ip ?? null }, 'auth.login', { type: 'user', id: result.user.id }, { via: 'invitation' });
    return result;
  }
}
