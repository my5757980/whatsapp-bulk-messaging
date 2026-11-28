import { Prisma } from '../../generated/prisma/client.js';

// Feature 009 (research R11): one definition of "replied" for the 005 retarget group, the campaign
// results, the reports and the export. A reply is a message from the contact to the same number within
// 72 hours after the campaign message was delivered (or read, when no delivered status came).

/** Hours after delivery in which a message from the contact counts as a reply (005 FR-012). */
export const REPLY_WINDOW_HOURS = 72;

const WINDOW = Prisma.raw(`interval '${REPLY_WINDOW_HOURS} hours'`);

/** The campaign message (alias `m`) was delivered or read. */
export const DELIVERED = Prisma.sql`m.status IN ('DELIVERED', 'READ')`;

/** The contact wrote to the number within the window after the message (alias `m`) was delivered. */
export const REPLIED = Prisma.sql`EXISTS (
  SELECT 1 FROM conversations cv JOIN chat_messages cm ON cm.conversation_id = cv.id
   WHERE cv.contact_id = m.contact_id AND cv.number_id = m.number_id AND cm.kind = 'INBOUND'
     AND cm.occurred_at >= COALESCE(m.delivered_at, m.read_at)
     AND cm.occurred_at < COALESCE(m.delivered_at, m.read_at) + ${WINDOW})`;

/** When the contact first replied to the delivered message (alias `m`), or null. */
export const REPLIED_AT = Prisma.sql`CASE WHEN ${DELIVERED} THEN (
  SELECT min(cm.occurred_at) FROM conversations cv JOIN chat_messages cm ON cm.conversation_id = cv.id
   WHERE cv.contact_id = m.contact_id AND cv.number_id = m.number_id AND cm.kind = 'INBOUND'
     AND cm.occurred_at >= COALESCE(m.delivered_at, m.read_at)
     AND cm.occurred_at < COALESCE(m.delivered_at, m.read_at) + ${WINDOW}) END`;

/** Someone clicked one of the message's (alias `m`) tracked links (005). */
export const CLICKED = Prisma.sql`EXISTS (SELECT 1 FROM tracked_links tl JOIN link_clicks lc ON lc.tracked_link_id = tl.id WHERE tl.message_id = m.id)`;
