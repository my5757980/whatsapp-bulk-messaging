import { createHmac, randomBytes } from 'node:crypto';

// Feature 010 (US6, research R10): time-based one-time codes (RFC 6238 over RFC 4226 HOTP) with node:crypto.
// SHA-1, 6 digits, 30-second steps, one step either side; the last accepted step is kept by the caller so a
// code is never accepted twice.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Steps accepted either side of the current one (clock drift). */
export const TOTP_WINDOW = 1;

/** RFC 4648 base32 without padding. */
export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** Reads base32, ignoring case, spaces and padding; throws on other characters. */
export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new Error('Not base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes in base32 (32 characters). */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** RFC 4226 HOTP for a counter. */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secret).update(message).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 10 ** digits).padStart(digits, '0');
}

/** The time step of an instant (Unix seconds / 30). */
export const totpStep = (unixMs: number) => Math.floor(unixMs / 1000 / TOTP_STEP_SECONDS);

/** The code for an instant. */
export function totpCode(secretBase32: string, unixMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretBase32), totpStep(unixMs), digits);
}

/**
 * The step a code matches at `unixMs` (one step either side), or null. A step at or before `lastStep` is
 * refused, so an accepted code cannot be used again.
 */
export function verifyTotp(secretBase32: string, code: string, unixMs: number, lastStep: number | null = null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const now = totpStep(unixMs);
  for (let step = now - TOTP_WINDOW; step <= now + TOTP_WINDOW; step++) {
    if (lastStep !== null && step <= lastStep) continue;
    if (hotp(secret, step) === code) return step;
  }
  return null;
}

/** The address authenticator apps read from the QR code. */
export function otpauthUrl(issuer: string, account: string, secretBase32: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const query = new URLSearchParams({ secret: secretBase32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS) });
  return `otpauth://totp/${label}?${query.toString()}`;
}
