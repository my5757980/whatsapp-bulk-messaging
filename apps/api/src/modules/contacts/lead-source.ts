import type { LeadSourceKind } from '@wbm/shared';
import type { Prisma } from '../../generated/prisma/client.js';

// Feature 010 (research R5, FR-011): a contact's lead source is written once, in the create branch of the
// upsert that makes the contact. Every creation path goes through leadSourceFor().

const LABEL_MAX = 80;

/** The fields to put in the create branch for a new contact. */
export function leadSourceFor(kind: LeadSourceKind, label?: string | null): { leadSourceKind: LeadSourceKind; leadSource: string | null } {
  const text = label?.trim().slice(0, LABEL_MAX);
  return { leadSourceKind: kind, leadSource: text ? text : null };
}

type Db = Pick<Prisma.TransactionClient, 'contact'>;

/**
 * The inbound handler creates a new contact as ORGANIC before the matchers read the first message. When
 * that same first message carries a chat link reference, a website button reference or an ad referral,
 * the matcher calls this to record the real origin. Callers only call it for a contact created by the
 * current message (their `newContact` flag); a source other than ORGANIC is never changed.
 */
export async function upgradeFirstMessageSource(db: Db, contactId: string, kind: Exclude<LeadSourceKind, 'ORGANIC' | 'UNKNOWN'>, label?: string | null): Promise<boolean> {
  const { count } = await db.contact.updateMany({ where: { id: contactId, leadSourceKind: 'ORGANIC' }, data: leadSourceFor(kind, label) });
  return count > 0;
}
