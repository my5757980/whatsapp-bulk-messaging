import { createHmac, randomInt } from 'node:crypto';

// Feature 010 (US6, research R10): 10 one-use recovery codes of 10 characters. They use the upper-case
// letters and digits of the 006 link-code alphabet, because members may type them in any case. Only a keyed
// hash (HMAC-SHA256 with the server key) is stored.

export const RECOVERY_CODE_COUNT = 10;
export const RECOVERY_CODE_LENGTH = 10;
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Upper case, without spaces or dashes. */
export function normalizeRecoveryCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]/g, '');
}

/** New codes, shown as `ABCDE-FGHJK` (the dash is optional when typed). */
export function newRecoveryCodes(): string[] {
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => {
    const raw = Array.from({ length: RECOVERY_CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });
}

/** The keyed hash stored for a code. */
export function hashRecoveryCode(key: Buffer, code: string): string {
  return createHmac('sha256', key).update(`recovery:${normalizeRecoveryCode(code)}`).digest('hex');
}
