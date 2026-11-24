import { Injectable } from '@nestjs/common';
import { MAX_ACTIVE_ENROLMENTS, enrolDecision, type EnrolmentStatusCode } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { PageQuerySchema } from '../../../common/validation/pagination.js';
import type { EnrolmentStatus, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { AudienceFilterSchema, AudienceQueryBuilder } from '../../contacts/audience-query.builder.js';
import { DripLeaving } from './drip-leaving.js';

// Enrolling contacts in a drip by hand, and the list of contacts in it (feature 005 US4, FR-025 - FR-027).

export const EnrolInputSchema = z
  .union([
    z.object({ contactIds: z.array(z.uuid()).min(1).max(1000) }).strict(),
    z.object({ filter: AudienceFilterSchema }).strict(),
  ])
  .refine((v) => ('contactIds' in v ? true : v.filter.all.length > 0), { message: 'Add at least one filter rule' });
export type EnrolInput = z.infer<typeof EnrolInputSchema>;

export const EnrolmentListQuerySchema = PageQuerySchema.extend({
  status: z.enum(['ACTIVE', 'FINISHED', 'LEFT']).optional(),
  position: z.coerce.number().int().min(1).max(10).optional(),
});
export type EnrolmentListQuery = z.infer<typeof EnrolmentListQuerySchema>;

export interface EnrolResult {
  enrolled: number;
  skippedOptedOut: number;
  skippedAlreadyIn: number;
  skippedNotFound: number;
}

export interface EnrolmentDto {
  id: string;
  contact: { id: string | null; name: string | null; phone: string | null };
  status: EnrolmentStatus;
  joinedVia: string;
  currentPosition: number;
  nextDueAt: string | null;
  leftReason: string | null;
  joinedAt: string;
  endedAt: string | null;
}

interface Candidate {
  id: string;
  consent: string;
  blocked: boolean;
}

@Injectable()
export class EnrolmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: AudienceQueryBuilder,
    private readonly audit: AuditService,
    private readonly leaving: DripLeaving,
    private readonly metrics: MetricsService,
  ) {}

  /** Enrols chosen contacts or a filter (FR-025). Opted-out and blocked contacts, and contacts already in, are counted and skipped. */
  async enrol(dripId: string, input: EnrolInput, actor: AuditActor, dryRun = false): Promise<EnrolResult> {
    const drip = await this.prisma.drip.findUnique({
      where: { id: dripId },
      select: { status: true, allowRejoin: true, steps: { where: { deletedAt: null, position: 1 }, select: { waitMinutes: true } } },
    });
    if (!drip) throw AppError.notFound('Drip not found');
    if (!dryRun && drip.status !== 'ACTIVE') throw AppError.conflict('Contacts can join an active drip only', 'NOT_ACTIVE');

    const result: EnrolResult = { enrolled: 0, skippedOptedOut: 0, skippedAlreadyIn: 0, skippedNotFound: 0 };
    const now = new Date();
    const firstWait = drip.steps[0]?.waitMinutes ?? 0;
    let active = await this.prisma.dripEnrolment.count({ where: { dripId, status: 'ACTIVE' } });

    for await (const batch of this.candidates(input, result)) {
      const previous = await this.prisma.dripEnrolment.findMany({
        where: { dripId, contactId: { in: batch.map((c) => c.id) } },
        select: { contactId: true, status: true },
      });
      const history = new Map<string, EnrolmentStatusCode[]>();
      for (const p of previous) if (p.contactId) history.set(p.contactId, [...(history.get(p.contactId) ?? []), p.status]);

      const joining: string[] = [];
      for (const c of batch) {
        if (c.consent === 'OPTED_OUT' || c.blocked) result.skippedOptedOut += 1;
        else if (enrolDecision(history.get(c.id) ?? [], drip.allowRejoin) !== 'ENROL') result.skippedAlreadyIn += 1;
        else joining.push(c.id);
      }
      if (active + joining.length > MAX_ACTIVE_ENROLMENTS) {
        throw AppError.validation(`A drip can hold at most ${MAX_ACTIVE_ENROLMENTS.toLocaleString('en')} contacts at a time`, [{ field: 'contactIds', issue: 'too many contacts' }]);
      }
      if (dryRun) {
        result.enrolled += joining.length;
        continue;
      }
      const { count } = await this.prisma.dripEnrolment.createMany({
        data: joining.map((contactId) => ({
          dripId,
          contactId,
          joinedVia: 'MANUAL' as const,
          joinedById: actor.userId ?? null,
          currentPosition: 1,
          nextDueAt: new Date(now.getTime() + firstWait * 60_000),
          joinedAt: now,
        })),
        // A concurrent starting event may have enrolled the same contact (partial unique index).
        skipDuplicates: true,
      });
      result.enrolled += count;
      result.skippedAlreadyIn += joining.length - count;
      active += count;
    }

    if (!dryRun) {
      if (result.enrolled) this.metrics.dripEnrolmentsTotal.inc({ via: 'manual' }, result.enrolled);
      await this.audit.record(actor, 'drip.contacts_enrolled', { type: 'drip', id: dripId }, { ...result, by: 'contactIds' in input ? 'contacts' : 'filter' });
    }
    return result;
  }

  async list(dripId: string, query: EnrolmentListQuery): Promise<{ items: EnrolmentDto[]; total: number }> {
    if (!(await this.prisma.drip.findUnique({ where: { id: dripId }, select: { id: true } }))) throw AppError.notFound('Drip not found');
    const where: Prisma.DripEnrolmentWhereInput = {
      dripId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.position ? { currentPosition: query.position } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.dripEnrolment.count({ where }),
      this.prisma.dripEnrolment.findMany({
        where,
        include: { contact: { select: { id: true, name: true, phoneE164: true } } },
        orderBy: [{ joinedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
    ]);
    return {
      total,
      items: rows.map((e) => ({
        id: e.id,
        contact: { id: e.contactId, name: e.contact?.name ?? null, phone: e.contact?.phoneE164 ?? null },
        status: e.status,
        joinedVia: e.joinedVia,
        currentPosition: e.currentPosition,
        nextDueAt: e.nextDueAt?.toISOString() ?? null,
        leftReason: e.leftReason,
        joinedAt: e.joinedAt.toISOString(),
        endedAt: e.endedAt?.toISOString() ?? null,
      })),
    };
  }

  /** A member removes a contact from the drip (leaves with REMOVED; audited). */
  async remove(dripId: string, enrolmentId: string, actor: AuditActor): Promise<void> {
    const enrolment = await this.prisma.dripEnrolment.findFirst({ where: { id: enrolmentId, dripId }, select: { id: true } });
    if (!enrolment) throw AppError.notFound('This contact is not in the drip');
    if (!(await this.leaving.leaveEnrolment(enrolmentId, 'REMOVED'))) throw AppError.conflict('The contact already finished or left the drip', 'NOT_IN_DRIP');
    await this.audit.record(actor, 'drip.contact_removed', { type: 'drip', id: dripId }, { enrolmentId });
  }

  /** Chosen contacts (counting ids that do not exist) or the contacts matching a filter, in batches. */
  private async *candidates(input: EnrolInput, result: EnrolResult): AsyncGenerator<Candidate[]> {
    if ('contactIds' in input) {
      const ids = [...new Set(input.contactIds)];
      const found = await this.prisma.contact.findMany({ where: { id: { in: ids } }, select: { id: true, consentStatus: true, blockedAt: true } });
      result.skippedNotFound += ids.length - found.length;
      if (found.length) yield found.map((c) => ({ id: c.id, consent: c.consentStatus, blocked: c.blockedAt !== null }));
      return;
    }
    for await (const batch of this.audience.iterate({ type: 'FILTER', filter: input.filter })) {
      const blocked = new Set(
        (await this.prisma.contact.findMany({ where: { id: { in: batch.map((c) => c.id) }, blockedAt: { not: null } }, select: { id: true } })).map((c) => c.id),
      );
      yield batch.map((c) => ({ id: c.id, consent: c.consent_status, blocked: blocked.has(c.id) }));
    }
  }
}
