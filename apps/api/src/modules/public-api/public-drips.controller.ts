import { Body, Controller, Delete, Headers, HttpCode, Injectable, Param, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { Public } from '../../common/auth/public.decorator.js';
import { clientIp } from '../../common/auth/request-user.js';
import { AppError } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { AuditActor } from '../audit/audit.service.js';
import { EnrolmentsService } from '../growth/drips/enrolments.service.js';
import { ApiKeyGuard, type ApiRequest } from './api-key.guard.js';
import { RequireScope } from './api-scope.decorator.js';
import { IdempotentResponses } from './idempotent-responses.service.js';
import { answerOnce, keyOf } from './public-contacts.controller.js';
import { PublicContactsService } from './public-contacts.service.js';
import { RateLimitGuard } from './rate-limit.guard.js';

// Drip enrolment through the public API (feature 006 US2, FR-014): the 005 rules apply (active
// drips only, no opted-out or blocked contacts, rejoining as the drip allows); `{drip}` is the
// drip's id or its exact name.

export const EnrolBodySchema = z.union([z.object({ contactId: z.uuid() }).strict(), z.object({ phone: z.string().trim().min(1).max(32) }).strict()]);
export type EnrolBody = z.infer<typeof EnrolBodySchema>;

export type EnrolReason = 'opted_out' | 'blocked' | 'already_in' | 'not_found';

const isUuid = (value: string) => z.uuid().safeParse(value).success;

@Injectable()
export class PublicDripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly enrolments: EnrolmentsService,
    private readonly contacts: PublicContactsService,
  ) {}

  async enrol(ref: string, body: EnrolBody, actor: AuditActor): Promise<{ enrolled: boolean; reason: EnrolReason | null }> {
    const drip = await this.drip(ref);
    if (drip.status !== 'ACTIVE') throw AppError.conflict('Contacts can join an active drip only', 'NOT_ACTIVE');
    const where = 'contactId' in body ? { id: body.contactId } : { phoneE164: (await this.contacts.normalise(body.phone)).e164 };
    const contact = await this.prisma.contact.findUnique({ where, select: { id: true, blockedAt: true } });
    if (!contact) return { enrolled: false, reason: 'not_found' };

    const result = await this.enrolments.enrol(drip.id, { contactIds: [contact.id] }, actor);
    if (result.enrolled) return { enrolled: true, reason: null };
    if (result.skippedNotFound) return { enrolled: false, reason: 'not_found' };
    if (result.skippedOptedOut) return { enrolled: false, reason: contact.blockedAt ? 'blocked' : 'opted_out' };
    return { enrolled: false, reason: 'already_in' };
  }

  /** The contact leaves with the reason REMOVED (005 FR-027). */
  async remove(ref: string, contactId: string, actor: AuditActor): Promise<void> {
    const drip = await this.drip(ref);
    const enrolment = isUuid(contactId)
      ? await this.prisma.dripEnrolment.findFirst({ where: { dripId: drip.id, contactId, status: 'ACTIVE' }, select: { id: true } })
      : null;
    if (!enrolment) throw AppError.notFound('This contact is not in the drip');
    try {
      await this.enrolments.remove(drip.id, enrolment.id, actor);
    } catch (error) {
      // It finished or left a moment ago.
      if (error instanceof AppError && error.code === 'NOT_IN_DRIP') throw AppError.notFound('This contact is not in the drip');
      throw error;
    }
  }

  /** By id, or by exact name among drips that are not archived (names are unique there). */
  private async drip(ref: string) {
    const drip = isUuid(ref)
      ? await this.prisma.drip.findUnique({ where: { id: ref }, select: { id: true, status: true } })
      : await this.prisma.drip.findFirst({ where: { name: ref, status: { not: 'ARCHIVED' } }, select: { id: true, status: true } });
    if (!drip) throw AppError.notFound('Drip not found');
    return drip;
  }
}

@Controller('v1')
@Public()
@UseGuards(ApiKeyGuard, RateLimitGuard)
@RequireScope('drips.enrol')
export class PublicDripsController {
  constructor(
    private readonly drips: PublicDripsService,
    private readonly idempotent: IdempotentResponses,
  ) {}

  @Post('drips/:drip/enrolments')
  @HttpCode(200)
  enrol(
    @Param('drip') drip: string,
    @Body(new ZodValidationPipe(EnrolBodySchema)) body: EnrolBody,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, body, async () => ({
      status: 200,
      body: await this.drips.enrol(drip, body, { apiKeyId: keyOf(req).id, ip: clientIp(req) ?? null }),
    }));
  }

  @Delete('drips/:drip/enrolments/:contactId')
  @HttpCode(204)
  remove(
    @Param('drip') drip: string,
    @Param('contactId') contactId: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() req: ApiRequest,
    @Res({ passthrough: true }) res: Response,
  ) {
    return answerOnce(this.idempotent, req, res, idempotencyKey, {}, async () => {
      await this.drips.remove(drip, contactId, { apiKeyId: keyOf(req).id, ip: clientIp(req) ?? null });
      return { status: 204, body: undefined };
    });
  }
}
