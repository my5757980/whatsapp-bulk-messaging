import { describe, expect, it } from 'vitest';
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUrl, totpCode, totpStep, verifyTotp } from '../../../src/common/auth/totp.js';
import { hashRecoveryCode, newRecoveryCodes, normalizeRecoveryCode } from '../../../src/modules/auth/recovery-codes.js';

// T064 (feature 010 US6, research R10): RFC 6238 codes, the accepted window, replay, base32, the setup
// address and recovery codes.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));

describe('TOTP (RFC 6238)', () => {
  it('matches the RFC 6238 SHA-1 test vectors', () => {
    const vectors: Array<[number, string]> = [
      [59, '94287082'],
      [1111111109, '07081804'],
      [1111111111, '14050471'],
      [1234567890, '89005924'],
      [2000000000, '69279037'],
      [20000000000, '65353130'],
    ];
    for (const [seconds, code] of vectors) expect(totpCode(RFC_SECRET, seconds * 1000, 8), String(seconds)).toBe(code);
  });

  it('matches the RFC 4226 HOTP values', () => {
    const secret = Buffer.from('12345678901234567890', 'ascii');
    expect([0, 1, 2, 9].map((c) => hotp(secret, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('accepts one step either side and refuses two', () => {
    const secret = newTotpSecret();
    const now = Date.UTC(2027, 0, 1, 12, 0, 15);
    const step = totpStep(now);
    expect(verifyTotp(secret, totpCode(secret, now), now)).toBe(step);
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now)).toBe(step - 1);
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now)).toBe(step + 1);
    expect(verifyTotp(secret, totpCode(secret, now - 60_000), now)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 60_000), now)).toBeNull();
    expect(verifyTotp(secret, '12345', now)).toBeNull();
    expect(verifyTotp(secret, 'abcdef', now)).toBeNull();
  });

  it('never accepts a step at or before the last accepted one', () => {
    const secret = newTotpSecret();
    const now = Date.UTC(2027, 0, 1, 12, 0, 15);
    const code = totpCode(secret, now);
    const step = verifyTotp(secret, code, now)!;
    expect(verifyTotp(secret, code, now, step)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now - 30_000), now, step)).toBeNull();
    expect(verifyTotp(secret, totpCode(secret, now + 30_000), now, step)).toBe(step + 1);
  });

  it('round-trips base32 and makes 32-character secrets', () => {
    const bytes = Buffer.from([0, 1, 2, 250, 251, 252, 253, 254, 255, 7, 8]);
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
    expect(base32Decode('mzxw 6ytb oi==').toString()).toBe('foobar');
    expect(() => base32Decode('ABC1')).toThrow();
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('writes the otpauth address authenticator apps read', () => {
    expect(otpauthUrl('WhatsApp Platform', 'sara@acme.test', 'JBSWY3DPEHPK3PXP')).toBe(
      'otpauth://totp/WhatsApp%20Platform:sara%40acme.test?secret=JBSWY3DPEHPK3PXP&issuer=WhatsApp+Platform&algorithm=SHA1&digits=6&period=30',
    );
  });
});

describe('recovery codes', () => {
  it('makes 10 different codes of 10 characters', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  });

  it('ignores case, spaces and dashes', () => {
    expect(normalizeRecoveryCode(' abcde-fg h12 ')).toBe('ABCDEFGH12');
    const key = Buffer.alloc(32, 7);
    expect(hashRecoveryCode(key, 'ABCDE-FGH12')).toBe(hashRecoveryCode(key, 'abcde fgh12'));
    expect(hashRecoveryCode(key, 'ABCDE-FGH12')).not.toBe(hashRecoveryCode(Buffer.alloc(32, 8), 'ABCDE-FGH12'));
    expect(hashRecoveryCode(key, 'ABCDE-FGH12')).toMatch(/^[0-9a-f]{64}$/);
  });
});
