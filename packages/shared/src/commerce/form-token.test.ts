import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeFormToken, encodeFormToken, type TokenSigner } from './form-token.js';

// T012 (feature 008, research R12): the signed flow_token that maps an answer back to its form
// version, contact and send. The api signs with TOKEN_ENCRYPTION_KEY; tests inject a signer.
const sign: TokenSigner = (content) => createHmac('sha256', 'test-key').update(content).digest('base64url').slice(0, 22);
const payload = {
  versionId: '0196f1f0-1111-7000-8000-000000000001',
  contactId: '0196f1f0-2222-7000-8000-000000000002',
  ref: 'chat' as const,
  refId: '0196f1f0-3333-7000-8000-000000000003',
};

describe('form tokens', () => {
  it('round-trips and holds no personal data', () => {
    const token = encodeFormToken(payload, sign);
    expect(token).toMatch(/^wf1\.[0-9a-f]{64}[cmsr][0-9a-f]{32}\.[A-Za-z0-9_-]{22}$/);
    expect(token.length).toBeLessThan(140);
    expect(decodeFormToken(token, sign)).toEqual(payload);
    for (const ref of ['message', 'session', 'recipient'] as const) {
      expect(decodeFormToken(encodeFormToken({ ...payload, ref }, sign), sign)?.ref).toBe(ref);
    }
  });

  it('refuses a changed payload, a changed mac, another key and junk', () => {
    const token = encodeFormToken(payload, sign);
    const flipped = token.replace(/\.([0-9a-f])/, (_, c: string) => `.${c === 'a' ? 'b' : 'a'}`);
    expect(decodeFormToken(flipped, sign)).toBeNull();
    expect(decodeFormToken(`${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`, sign)).toBeNull();
    const other: TokenSigner = (content) => createHmac('sha256', 'other-key').update(content).digest('base64url').slice(0, 22);
    expect(decodeFormToken(token, other)).toBeNull();
    expect(decodeFormToken('unused', sign)).toBeNull();
    expect(decodeFormToken('', sign)).toBeNull();
    expect(decodeFormToken(token.replace('wf1.', 'wf2.'), sign)).toBeNull();
  });
});
