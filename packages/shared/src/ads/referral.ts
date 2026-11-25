// Chats from ads (feature 007, FR-021 – FR-023, research R11): the referral Meta adds to a customer's
// message, and Meta's free entry point window shown in live chat.

export interface AdReferral {
  metaAdId: string;
  headline: string | null;
  body: string | null;
  mediaType: string | null;
  mediaUrl: string | null;
  sourceUrl: string | null;
  /** Left out by Meta for WhatsApp Status placements. */
  ctwaClid: string | null;
}

const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null);

/** The referral of an ad; null for posts, or when Meta names no ad. */
export function parseAdReferral(raw: unknown): AdReferral | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const metaAdId = text(r.source_id, 40);
  if (r.source_type !== 'ad' || !metaAdId) return null;
  return {
    metaAdId,
    headline: text(r.headline, 500),
    body: text(r.body, 500),
    mediaType: text(r.media_type, 20),
    mediaUrl: text(r.image_url, 2000) ?? text(r.video_url, 2000) ?? text(r.thumbnail_url, 2000),
    sourceUrl: text(r.source_url, 2000),
    ctwaClid: text(r.ctwa_clid, 200),
  };
}

const HOUR_MS = 3_600_000;
/** The business must reply within this long for Meta's free window to open. */
export const FREE_WINDOW_REPLY_HOURS = 24;

export type FreeWindow =
  | { state: 'REPLY_TO_OPEN'; replyBy: Date }
  | { state: 'OPEN'; until: Date }
  | { state: 'ENDED'; until: Date }
  | { state: 'MISSED' };

/** Meta's free entry point window (information only; it never changes what may be sent). */
export function freeWindow(startedAt: Date, firstReplyAt: Date | null, now: Date, hours: number): FreeWindow {
  const replyBy = new Date(startedAt.getTime() + FREE_WINDOW_REPLY_HOURS * HOUR_MS);
  if (!firstReplyAt) return now.getTime() < replyBy.getTime() ? { state: 'REPLY_TO_OPEN', replyBy } : { state: 'MISSED' };
  if (firstReplyAt.getTime() > replyBy.getTime()) return { state: 'MISSED' };
  const until = new Date(firstReplyAt.getTime() + hours * HOUR_MS);
  return now.getTime() < until.getTime() ? { state: 'OPEN', until } : { state: 'ENDED', until };
}
