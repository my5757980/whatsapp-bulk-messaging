import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type { ReportRange } from './report-range.js';

// Feature 009 (research R14, FR-036): every opt-in and opt-out in the range with its source and the
// member who made it, plus counts by local day and source (consent_events, indexed on created_at).

export interface ConsentItem {
  contactId: string;
  name: string | null;
  phone: string;
  status: 'OPTED_IN' | 'OPTED_OUT' | 'UNKNOWN';
  source: string;
  note: string | null;
  actor: string | null;
  at: string;
}

const INCLUDE = { contact: { select: { name: true, phoneE164: true } }, actorUser: { select: { name: true } } } as const;
type EventRow = Prisma.ConsentEventGetPayload<{ include: typeof INCLUDE }>;

function toItem(e: EventRow): ConsentItem {
  return { contactId: e.contactId, name: e.contact.name, phone: e.contact.phoneE164, status: e.status, source: e.source, note: e.note, actor: e.actorUser?.name ?? null, at: e.createdAt.toISOString() };
}

@Injectable()
export class ConsentReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(range: ReportRange, page: number, pageSize: number, status?: 'OPTED_IN' | 'OPTED_OUT') {
    const where = { createdAt: { gte: range.start, lt: range.end }, ...(status ? { status } : {}) };
    const [events, total, counts] = await Promise.all([
      this.prisma.consentEvent.findMany({ where, include: INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (page - 1) * pageSize, take: pageSize }),
      this.prisma.consentEvent.count({ where }),
      this.prisma.$queryRaw<Array<{ day: string; source: string; opted_in: number; opted_out: number }>>`
        SELECT to_char((e.created_at AT TIME ZONE ${range.timeZone})::date, 'YYYY-MM-DD') AS day, e.source::text AS source,
               COUNT(*) FILTER (WHERE e.status = 'OPTED_IN')::int AS opted_in, COUNT(*) FILTER (WHERE e.status = 'OPTED_OUT')::int AS opted_out
          FROM consent_events e
         WHERE e.created_at >= ${range.start} AND e.created_at < ${range.end}
         GROUP BY 1, 2
         ORDER BY 1, 2`,
    ]);
    return {
      from: range.from,
      to: range.to,
      counts: counts.map((c) => ({ day: c.day, source: c.source, optedIn: c.opted_in, optedOut: c.opted_out })),
      items: events.map(toItem),
      total,
    };
  }

  /** Every change in the range, oldest first, in batches (flat memory). */
  async *stream(range: ReportRange, batchSize = 1000): AsyncGenerator<ConsentItem[]> {
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.prisma.consentEvent.findMany({
        where: { createdAt: { gte: range.start, lt: range.end } },
        include: INCLUDE,
        orderBy: { id: 'asc' },
        take: batchSize,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (!batch.length) return;
      cursor = batch[batch.length - 1]!.id;
      yield batch.map(toItem);
      if (batch.length < batchSize) return;
    }
  }
}
