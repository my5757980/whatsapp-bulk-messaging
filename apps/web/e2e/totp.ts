import { createHmac } from 'node:crypto';

// Feature 010 (US6): the authenticator app's code for a base32 secret (RFC 6238: SHA-1, 6 digits, 30 s).

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function decode(secret: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of secret.toUpperCase().replace(/[\s=]/g, '')) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** The code `stepsAhead` steps after now (the server accepts one step either side, each step once). */
export function totp(secret: string, stepsAhead = 0, now = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 30_000) + stepsAhead));
  const hmac = createHmac('sha1', decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const binary = ((hmac[offset]! & 0x7f) << 24) | (hmac[offset + 1]! << 16) | (hmac[offset + 2]! << 8) | hmac[offset + 3]!;
  return String(binary % 1_000_000).padStart(6, '0');
}
