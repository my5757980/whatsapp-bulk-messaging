import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verifies Meta's `X-Hub-Signature-256: sha256=<hex>` header: HMAC-SHA256 of the raw request
 * body with the app secret, compared in constant time (contracts/meta-webhooks.md §2).
 */
export function verifyMetaSignature(rawBody: Buffer, header: string | undefined, appSecret: string): boolean {
  if (!header?.startsWith('sha256=') || !appSecret) return false;
  const given = Buffer.from(header.slice('sha256='.length), 'utf8');
  const expected = Buffer.from(createHmac('sha256', appSecret).update(rawBody).digest('hex'), 'utf8');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
