import { Body, Controller, Get, HttpCode, Inject, Injectable, Param, ParseUUIDPipe, Patch, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { Public } from '../../common/auth/public.decorator.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import { setAuthCookies } from '../auth/auth.cookies.js';
import { AuthService, toPublicUser } from '../auth/auth.service.js';
import { InvitationsService } from './invitations.service.js';
import { ChatRoutingService } from '../inbox/routing/chat-routing.service.js';

const RoleSchema = z.enum(['ADMIN', 'MANAGER', 'AGENT']);
const InviteSchema = z.object({ email: z.email(), role: RoleSchema }).strict();
const UpdateUserSchema = z.object({ role: RoleSchema, status: z.enum(['ACTIVE', 'DEACTIVATED']) }).partial().strict();
const AcceptSchema = z.object({ name: z.string().trim().min(1).max(120), password: z.string().min(12, 'must be at least 12 characters').max(200) }).strict();

/** Team members (FR-006, T173): role and status changes with the last-admin guard. */
@Injectable()
export class UsersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly chatRouting: ChatRoutingService,
  ) {}

  async list() {
    const users = await this.prisma.user.findMany({ orderBy: [{ createdAt: 'asc' }] });
    return users.map(toPublicUser);
  }

  async update(id: string, input: z.infer<typeof UpdateUserSchema>, actor: AuditActor) {
    const updated = await this.prisma.$transaction(async (tx) => {
      // Lock the active admins so two concurrent changes cannot remove the last one.
      await tx.$queryRaw`SELECT id FROM users WHERE role = 'ADMIN'::"Role" AND status = 'ACTIVE'::"UserStatus" FOR UPDATE`;
      const user = await tx.user.findUnique({ where: { id } });
      if (!user) throw AppError.notFound('User not found');
      if (input.status === 'ACTIVE' && user.status === 'INVITED') throw AppError.conflict('This person has not accepted the invitation yet');
      const losesAdmin = user.role === 'ADMIN' && user.status === 'ACTIVE' && ((input.role && input.role !== 'ADMIN') || input.status === 'DEACTIVATED');
      if (losesAdmin && !(await tx.user.count({ where: { role: 'ADMIN', status: 'ACTIVE', id: { not: id } } }))) {
        throw AppError.conflict('Keep at least one active admin', 'LAST_ADMIN');
      }
      const next = await tx.user.update({ where: { id }, data: { ...(input.role ? { role: input.role } : {}), ...(input.status ? { status: input.status } : {}) } });
      return { before: user, after: next };
    });

    const { before, after } = updated;
    if (before.role !== after.role) await this.audit.record(actor, 'user.role_changed', { type: 'user', id }, { from: before.role, to: after.role });
    if (before.status === 'ACTIVE' && after.status === 'DEACTIVATED') {
      await this.chatRouting.releaseChats({ ownerId: id });
      await this.auth.revokeAllSessions(id);
      await this.audit.record(actor, 'user.deactivated', { type: 'user', id });
    }
    if (before.status === 'DEACTIVATED' && after.status === 'ACTIVE') await this.audit.record(actor, 'user.reactivated', { type: 'user', id });
    return toPublicUser(after);
  }
}

@Controller('users')
export class UsersController {
  constructor(
    private readonly users: UsersService,
    private readonly invitations: InvitationsService,
  ) {}

  @Get()
  @Require('users.manage')
  list() {
    return this.users.list();
  }

  @Post('invitations')
  @Require('users.manage')
  invite(@Body(new ZodValidationPipe(InviteSchema)) body: z.infer<typeof InviteSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.invitations.invite(body, { userId: user.id, ip: clientIp(req) ?? null });
  }

  @Patch(':id')
  @Require('users.manage')
  update(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(UpdateUserSchema)) body: z.infer<typeof UpdateUserSchema>, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest) {
    return this.users.update(id, body, { userId: user.id, ip: clientIp(req) ?? null });
  }
}

/** Public invitation endpoints: check a link, then accept it (sets cookies like a sign-in). */
@Controller('auth/invitations')
export class InvitationsController {
  constructor(
    private readonly invitations: InvitationsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  @Get(':token')
  @Public()
  check(@Param('token') token: string) {
    return this.invitations.check(token);
  }

  @Post(':token/accept')
  @Public()
  @HttpCode(200)
  async accept(@Param('token') token: string, @Body(new ZodValidationPipe(AcceptSchema)) body: z.infer<typeof AcceptSchema>, @Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const ip = clientIp(req);
    const { user, sessionToken } = await this.invitations.accept(token, body, {
      ...(ip ? { ip } : {}),
      ...(req.headers['user-agent'] ? { userAgent: req.headers['user-agent'] } : {}),
    });
    setAuthCookies(res, sessionToken, this.config.COOKIE_SECURE);
    return toPublicUser(user);
  }
}
