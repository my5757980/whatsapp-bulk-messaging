import { createHmac, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SIGNATURE_TOLERANCE_SECONDS,
  isWebhookSecret,
  makeWebhookSecret,
  parseSignatureHeader,
  secretKey,
  signatureHeader,
  signedContent,
  verifyWebhook,
  type Hmac,
} from './signing.js';

// T008 (feature 006, research R1): Standard Webhooks signatures. The HMAC itself is passed in, so
// this module stays free of Node APIs for the browser bundle; the api passes node:crypto.
const hmac: Hmac = (key, content) => createHmac('sha256', key).update(content).digest('base64');

// The reference vector of the Standard Webhooks specification (a 24-byte secret).
const vector = {
  secret: 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw',
  id: 'msg_p5jXN8AQM9LWM0D4loKWxJek',
  timestamp: 1614265330,
  body: '{"test": 2432232314}',
  signature: 'v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=',
};

describe('signedContent and signatureHeader', () => {
  it('signs "{id}.{timestamp}.{body}" with the key decoded from the secret', () => {
    expect(signedContent(vector.id, vector.timestamp, vector.body)).toBe(`${vector.id}.${vector.timestamp}.${vector.body}`);
    expect(secretKey(vector.secret)).toHaveLength(24);
    expect(signatureHeader(hmac, [vector.secret], vector.id, vector.timestamp, vector.body)).toBe(vector.signature);
  });

  it('gives one v1 value per secret while a secret is being renewed', () => {
    const renewed = makeWebhookSecret(randomBytes(32));
    const header = signatureHeader(hmac, [renewed, vector.secret], vector.id, vector.timestamp, vector.body);
    const values = header.split(' ');
    expect(values).toHaveLength(2);
    expect(values.every((v) => v.startsWith('v1,'))).toBe(true);
    expect(values[1]).toBe(vector.signature);
    expect(parseSignatureHeader(header)).toEqual(values.map((v) => v.slice(3)));
  });
});

describe('verifyWebhook', () => {
  const at = (seconds: number) => ({ nowSeconds: seconds });

  it('accepts any matching value within 5 minutes, and refuses others', () => {
    const base = { hmac, secrets: [vector.secret], id: vector.id, timestamp: vector.timestamp, body: vector.body };
    expect(verifyWebhook({ ...base, header: vector.signature, ...at(vector.timestamp + 10) })).toBe(true);
    expect(verifyWebhook({ ...base, header: `v1,bm90IGl0 ${vector.signature}`, ...at(vector.timestamp) })).toBe(true);
    expect(verifyWebhook({ ...base, header: 'v1,bm90IGl0', ...at(vector.timestamp) })).toBe(false);
    expect(verifyWebhook({ ...base, body: '{"test": 1}', header: vector.signature, ...at(vector.timestamp) })).toBe(false);
    expect(verifyWebhook({ ...base, header: vector.signature.replace('v1,', 'v2,'), ...at(vector.timestamp) })).toBe(false);
  });

  it('refuses timestamps more than 5 minutes away', () => {
    const base = { hmac, secrets: [vector.secret], id: vector.id, timestamp: vector.timestamp, body: vector.body, header: vector.signature };
    expect(SIGNATURE_TOLERANCE_SECONDS).toBe(300);
    expect(verifyWebhook({ ...base, ...at(vector.timestamp + 300) })).toBe(true);
    expect(verifyWebhook({ ...base, ...at(vector.timestamp + 301) })).toBe(false);
    expect(verifyWebhook({ ...base, ...at(vector.timestamp - 301) })).toBe(false);
  });
});

describe('webhook secrets', () => {
  it('makes "whsec_" plus 32 random bytes in base64', () => {
    const secret = makeWebhookSecret(randomBytes(32));
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/]{43}=$/);
    expect(secretKey(secret)).toHaveLength(32);
    expect(() => makeWebhookSecret(new Uint8Array(16))).toThrow();
  });

  it('accepts secrets of 24 to 64 bytes with the prefix only', () => {
    expect(isWebhookSecret(vector.secret)).toBe(true);
    expect(isWebhookSecret(makeWebhookSecret(randomBytes(64)))).toBe(true);
    expect(isWebhookSecret('MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw')).toBe(false);
    expect(isWebhookSecret('whsec_short')).toBe(false);
    expect(() => secretKey('not-a-secret')).toThrow();
  });
});
