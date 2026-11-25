// Customer lists (feature 007, FR-032, research R8): Meta matches phone numbers normalized to digits
// with the country code, without a plus sign or leading zeros, then hashed with SHA-256 (in the api).

export function normalizePhoneForHash(e164: string | null | undefined): string | null {
  if (!e164) return null;
  const digits = e164.replace(/\D/g, '').replace(/^0+/, '');
  return digits.length >= 7 && digits.length <= 15 ? digits : null;
}

/** Meta takes at most this many hashes per call. */
export const AUDIENCE_BATCH = 10_000;
/** Audiences smaller than this are not offered (Meta's minimum for a lookalike source). */
export const AUDIENCE_MIN_SIZE = 100;
