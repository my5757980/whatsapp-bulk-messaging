import { Controller, Get, Query, Req, Res } from '@nestjs/common';
import { can, type LeadSourceKind } from '@wbm/shared';
import type { Response } from 'express';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import { CurrentUser, clientIp, type AuthedRequest, type RequestUser } from '../../common/auth/request-user.js';
import { maskPhone } from '../../common/phone/phone.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import { Prisma } from '../../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { csvField } from '../campaigns/csv.js';
import { ContactFilterSchema, contactFilterSql } from './contact-filter.sql.js';
import { SegmentQueryBuilder } from './segment-query.builder.js';

// Feature 010 (US2, FR-013, research R6): contacts as a streamed CSV for a segment, the list's filter or
// everyone. Nothing is stored; phones are masked for roles without phones.full; each download is audited.

export const ContactsExportQuerySchema = ContactFilterSchema.extend({ segmentId: z.uuid().optional() });
type ContactsExportQuery = z.infer<typeof ContactsExportQuerySchema>;

const BATCH = 2_000;

interface ExportRow {
  id: string;
  name: string | null;
  phone_e164: string;
  attributes: Record<string, unknown> | null;
  consent_status: string;
  consent_source: string | null;
  consent_at: Date | null;
  lead_source_kind: LeadSourceKind;
  lead_source: string | null;
  created_at: Date;
  tags: string[] | null;
  last_message_at: Date | null;
}

type Cell = string | number | null | undefined;
const line = (cells: Cell[]) => `${cells.map((c) => csvField(c ?? '')).join(',')}\n`;

/** One CSV line for a contact; exported for the unit test of masking. */
export function contactCsvLine(row: ExportRow, attributeKeys: readonly string[], phonesFull: boolean): string {
  const attrs = row.attributes ?? {};
  const value = (key: string) => {
    const v = attrs[key];
    return v === undefined || v === null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
  };
  return line([
    row.name,
    phonesFull ? row.phone_e164 : maskPhone(row.phone_e164),
    (row.tags ?? []).sort().join(';'),
    ...attributeKeys.map(value),
    row.consent_status,
    row.consent_source,
    row.consent_at?.toISOString() ?? '',
    row.lead_source_kind,
    row.lead_source,
    row.created_at.toISOString(),
    row.last_message_at?.toISOString() ?? '',
  ]);
}

@Controller('contacts')
export class ContactsExportController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly segments: SegmentQueryBuilder,
    private readonly audit: AuditService,
  ) {}

  @Get('export.csv')
  @Require('data.export')
  async export(@Query(new ZodValidationPipe(ContactsExportQuerySchema)) query: ContactsExportQuery, @CurrentUser() user: RequestUser, @Req() req: AuthedRequest, @Res() res: Response): Promise<void> {
    const filter = contactFilterSql(query);
    const where = query.segmentId ? Prisma.sql`(${await this.segments.whereFor(query.segmentId)}) AND (${filter})` : filter;
    const [counted, defs] = await Promise.all([
      this.prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM contacts c WHERE ${where}`,
      this.prisma.attributeDefinition.findMany({ select: { key: true }, orderBy: { key: 'asc' } }),
    ]);
    const rows = Number(counted[0]?.n ?? 0);
    const keys = defs.map((d) => d.key);
    const selection = query.segmentId ? 'segment' : query.q || query.tag.length || query.consent || query.leadSource ? 'filter' : 'everyone';
    await this.audit.record({ userId: user.id, ip: clientIp(req) ?? null }, 'data.exported', { type: 'contacts', id: query.segmentId ?? null }, { selection, rows, format: 'csv' });

    res.status(200);
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', `attachment; filename="contacts-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.write(line(['name', 'phone', 'tags', ...keys, 'consent_status', 'consent_source', 'consent_at', 'lead_source', 'lead_source_label', 'added_at', 'last_message_at']));
    const phonesFull = can(user.role, 'phones.full');
    let cursor: string | null = null;
    for (;;) {
      const after: Prisma.Sql = cursor ? Prisma.sql`AND c.id > ${cursor}::uuid` : Prisma.empty;
      const batch: ExportRow[] = await this.prisma.$queryRaw<ExportRow[]>`
        SELECT c.id, c.name, c.phone_e164, c.attributes, c.consent_status::text AS consent_status, c.consent_source::text AS consent_source,
               c.consent_at, c.lead_source_kind::text AS lead_source_kind, c.lead_source, c.created_at,
               (SELECT array_agg(t.name) FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id) AS tags,
               (SELECT max(cv.last_inbound_at) FROM conversations cv WHERE cv.contact_id = c.id) AS last_message_at
          FROM contacts c
         WHERE (${where}) ${after}
         ORDER BY c.id
         LIMIT ${BATCH}`;
      if (!batch.length) break;
      cursor = batch[batch.length - 1]!.id;
      const text = batch.map((r) => contactCsvLine(r, keys, phonesFull)).join('');
      if (!res.write(text)) await new Promise((resolve) => res.once('drain', resolve));
      if (batch.length < BATCH) break;
    }
    res.end();
  }
}
