import { LEAD_SOURCE_KINDS } from '@wbm/shared';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { normaliseTag } from './tags.controller.js';

// Feature 010: the contact list's filter (search, tags, consent, lead source) as SQL over `contacts c`.
// The list uses it with a segment (US1, FR-007); bulk tag actions and the export walk it in batches
// (US2, research R3, R6), so all three agree on who "all matching" is.

const tagList = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]).map(normaliseTag).filter(Boolean));

export const ContactFilterSchema = z.object({
  q: z.string().trim().max(100).optional(),
  tag: tagList,
  consent: z.enum(['OPTED_IN', 'OPTED_OUT', 'UNKNOWN']).optional(),
  leadSource: z.enum(LEAD_SOURCE_KINDS).optional(),
});
export type ContactFilter = z.infer<typeof ContactFilterSchema>;

const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The filter as one condition; an empty filter is TRUE. */
export function contactFilterSql(filter: Partial<ContactFilter>): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (filter.q) {
    // Phone search only for phone-like input, as in the 001 list.
    const digits = filter.q.replace(/\D/g, '');
    const phoneLike = /^[+\d\s().-]+$/.test(filter.q) && digits.length >= 3;
    const name = Prisma.sql`c.name ILIKE ${`%${escapeLike(filter.q)}%`} ESCAPE '\\'`;
    parts.push(phoneLike ? Prisma.sql`(${name} OR c.phone_e164 LIKE ${`%${digits}%`})` : name);
  }
  for (const tag of filter.tag ?? []) parts.push(Prisma.sql`EXISTS (SELECT 1 FROM contact_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.contact_id = c.id AND t.name = ${tag})`);
  if (filter.consent) parts.push(Prisma.sql`c.consent_status::text = ${filter.consent}`);
  if (filter.leadSource) parts.push(Prisma.sql`c.lead_source_kind::text = ${filter.leadSource}`);
  return parts.length ? Prisma.join(parts, ' AND ') : Prisma.sql`TRUE`;
}
