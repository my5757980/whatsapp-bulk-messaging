import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyMetaSignature } from '../../src/modules/webhooks/signature.js';

const secret = 'app-secret-for-tests';
const body = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [] }));
const sign = (raw: Buffer, key = secret) => `sha256=${createHmac('sha256', key).update(raw).digest('hex')}`;

describe('verifyMetaSignature (X-Hub-Signature-256)', () => {
  it('accepts a valid signature over the raw bytes', () => {
    expect(verifyMetaSignature(body, sign(body), secret)).toBe(true);
  });

  it('rejects a signature made with another secret', () => {
    expect(verifyMetaSignature(body, sign(body, 'other-secret'), secret)).toBe(false);
  });

  it('rejects a body changed after signing', () => {
    const tampered = Buffer.from(body.toString().replace('[]', '[{}]'));
    expect(verifyMetaSignature(tampered, sign(body), secret)).toBe(false);
  });

  it('rejects missing or malformed headers', () => {
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha1=abc', secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=short', secret)).toBe(false);
  });
});
