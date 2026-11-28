// Feature 009 (research R6, R7, R9, R10): launch rules for offers, carousel card media, media addresses
// and duplicate rows. The api runs them at launch; the wizard shows the same problems before.
import { HEADER_MEDIA } from '../template-rules.js';

export type OfferEndProblem = 'OFFER_ENDED' | 'OFFER_ENDS_BEFORE_START';

/** An offer must end in the future and after the scheduled start. */
export function offerEndProblem(endsAt: Date, scheduledAt: Date | null, now: Date): OfferEndProblem | null {
  if (endsAt.getTime() <= now.getTime()) return 'OFFER_ENDED';
  if (scheduledAt && endsAt.getTime() <= scheduledAt.getTime()) return 'OFFER_ENDS_BEFORE_START';
  return null;
}

export type CardMediaProblem = 'WRONG_TYPE' | 'TOO_LARGE';

/** A carousel card file must match the template's card format and the size limit. */
export function cardMediaProblem(format: 'IMAGE' | 'VIDEO', file: { mimeType: string; sizeBytes: number }): CardMediaProblem | null {
  const rule = HEADER_MEDIA[format];
  if (!rule.mimeTypes.includes(file.mimeType)) return 'WRONG_TYPE';
  return file.sizeBytes > rule.maxBytes ? 'TOO_LARGE' : null;
}

export type MediaUrlProblem = 'NOT_HTTPS' | 'NOT_PUBLIC' | 'UNREACHABLE' | 'WRONG_TYPE' | 'TOO_LARGE' | 'TIMEOUT';

/** The format check of a media address, before any request: https only. */
export function mediaUrlFormatProblem(value: string): 'NOT_HTTPS' | null {
  try {
    return new URL(value).protocol === 'https:' ? null : 'NOT_HTTPS';
  } catch {
    return 'NOT_HTTPS';
  }
}

/** Whether a response for a media address fits the header (content type and length). */
export function mediaResponseProblem(format: 'IMAGE' | 'VIDEO' | 'DOCUMENT', contentType: string | null, contentLength: number | null): 'WRONG_TYPE' | 'TOO_LARGE' | null {
  const rule = HEADER_MEDIA[format];
  const type = (contentType ?? '').split(';')[0]!.trim().toLowerCase();
  if (!rule.mimeTypes.includes(type)) return 'WRONG_TYPE';
  return contentLength !== null && contentLength > rule.maxBytes ? 'TOO_LARGE' : null;
}

/** At most this many distinct addresses are checked before launch; above it, a sample of this size. */
export const MEDIA_CHECK_MAX = 1_000;

/** "Send to every row" works only for uploaded audiences. */
export function duplicateRowsProblem(audienceType: string, allowDuplicateRows: boolean): 'DUPLICATES_NEED_UPLOAD' | null {
  return allowDuplicateRows && audienceType !== 'UPLOAD' ? 'DUPLICATES_NEED_UPLOAD' : null;
}
