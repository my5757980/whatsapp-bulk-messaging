// Meta Cloud API error classes (research R9). Codes from Meta's error-code reference; the retry
// class is our policy. Unknown codes are permanent so we never retry blindly.

export type MetaErrorClass = 'TRANSIENT' | 'PERMANENT' | 'BLOCKING';

const TRANSIENT = new Set([130429, 131000, 131016, 133004, 4, 80007, 131056]);
const BLOCKING = new Set([190, 10, 368, 133010, 132001, 132007, 132015, 132016]);

const REASONS: Readonly<Record<number, string>> = {
  4: 'The app reached its API call rate limit',
  10: 'Permission is not granted or was removed',
  190: 'The access token has expired or is invalid',
  368: 'The WhatsApp Business Account is restricted for a policy violation',
  80007: 'The WhatsApp Business Account reached its rate limit',
  130429: 'Cloud API message throughput was reached',
  131000: 'Message failed to send because of an unknown error',
  131016: 'A Meta service is temporarily unavailable',
  131026: 'Message undeliverable (number not on WhatsApp, terms not accepted, or old app)',
  131047: 'More than 24 hours passed since the customer last replied',
  131048: 'Sending is restricted because of the number quality',
  131049: 'Not delivered to maintain healthy ecosystem engagement (Meta limit)',
  131056: 'Too many messages to this customer in a short time',
  132000: 'Number of template parameters does not match the template',
  132001: 'Template does not exist in this language or is not approved',
  132005: 'Translated template text is too long',
  132007: 'Template content violates a WhatsApp policy',
  132012: 'Template parameter values are formatted incorrectly',
  132015: 'Template is paused because of low quality',
  132016: 'Template is permanently disabled',
  133004: 'Meta server is temporarily unavailable',
  133010: 'Phone number is not registered on the WhatsApp Business Platform',
};

/** Every Meta code the platform handles; each has a meaning in @wbm/shared help (feature 009, FR-028). */
export const HANDLED_META_CODES: readonly number[] = [...new Set([...TRANSIENT, ...BLOCKING, ...Object.keys(REASONS).map(Number)])].sort((a, b) => a - b);

export function classifyMetaError(code: number | undefined, httpStatus?: number): MetaErrorClass {
  if (code !== undefined) {
    if (TRANSIENT.has(code)) return 'TRANSIENT';
    if (BLOCKING.has(code)) return 'BLOCKING';
    return 'PERMANENT';
  }
  return httpStatus !== undefined && httpStatus >= 500 ? 'TRANSIENT' : 'PERMANENT';
}

/**
 * Failure reason of a send whose outcome is unknown (the request may have reached Meta). Such
 * messages are never sent again, so nobody gets a message twice (001 SC-004).
 */
export const AMBIGUOUS_FAILURE_REASON = 'unknown_outcome_not_retried';

/** Codes a campaign retry round may send again (feature 005, research R4): the TRANSIENT class. */
export const RETRYABLE_CODES: ReadonlySet<number> = TRANSIENT;

/** Meta's per-person marketing limit: wait at least 24 hours, so it is held back instead (FR-014). */
export const HELD_BACK_CODE = 131049;

export type RetryClass = 'RETRY' | 'HELD_BACK' | 'NEVER';

/**
 * Whether a failed campaign message may go into a retry round (feature 005, FR-014). Failures without
 * a Meta code (an HTTP 5xx, or Meta not reached) may be retried, except an unknown outcome.
 */
export function retryClassOf(failureCode: number | null | undefined, failureReason: string | null | undefined): RetryClass {
  if (failureCode === HELD_BACK_CODE) return 'HELD_BACK';
  if (failureCode === null || failureCode === undefined) return failureReason === AMBIGUOUS_FAILURE_REASON ? 'NEVER' : 'RETRY';
  return RETRYABLE_CODES.has(failureCode) ? 'RETRY' : 'NEVER';
}

/** Readable failure reason shown on recipient rows and reports. */
export function describeMetaError(code: number | undefined, fallback?: string): string {
  if (code !== undefined && REASONS[code]) return REASONS[code];
  const base = fallback?.trim() || 'Meta rejected the request';
  return code !== undefined ? `${base} (code ${code})` : base;
}
