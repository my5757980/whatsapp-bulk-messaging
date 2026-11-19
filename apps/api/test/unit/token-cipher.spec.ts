import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TokenCipher } from '../../src/common/crypto/token-cipher.js';

const key = () => randomBytes(32).toString('base64');

describe('TokenCipher (AES-256-GCM, research R15)', () => {
  it('round-trips a token', () => {
    const cipher = new TokenCipher(key());
    const payload = cipher.encrypt('EAAG-secret-token');
    expect(cipher.decrypt(payload)).toBe('EAAG-secret-token');
  });

  it('uses a random IV so equal inputs encrypt differently', () => {
    const cipher = new TokenCipher(key());
    expect(cipher.encrypt('same')).not.toBe(cipher.encrypt('same'));
  });

  it('prefixes the key version', () => {
    const payload = new TokenCipher(key()).encrypt('x');
    expect(payload.startsWith('v1:')).toBe(true);
    expect(payload.split(':')).toHaveLength(4);
  });

  it('rejects tampered ciphertext', () => {
    const cipher = new TokenCipher(key());
    const [v, iv, tag, ct] = cipher.encrypt('secret').split(':') as [string, string, string, string];
    const bytes = Buffer.from(ct, 'base64');
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;
    expect(() => cipher.decrypt([v, iv, tag, bytes.toString('base64')].join(':'))).toThrow();
  });

  it('rejects a payload encrypted with another key', () => {
    const payload = new TokenCipher(key()).encrypt('secret');
    expect(() => new TokenCipher(key()).decrypt(payload)).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new TokenCipher(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });

  it('rejects malformed payloads and unknown versions', () => {
    const cipher = new TokenCipher(key());
    expect(() => cipher.decrypt('not-a-payload')).toThrow();
    expect(() => cipher.decrypt(cipher.encrypt('x').replace(/^v1:/, 'v9:'))).toThrow(/version/);
  });
});
