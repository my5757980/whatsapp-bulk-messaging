// Stripe-Signature verification by hand (feature 008, research R3; Stripe's "verify manually" steps).
// Pure: the HMAC-SHA256 hex function is passed in (node:crypto in the api), like integrations/signing.ts.
import { timingSafeEqualString } from '../integrations/signing.js';

/** Stripe's libraries accept 5 minutes between the header timestamp and now. */
export const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

/** Returns the lower-case hex HMAC-SHA256 of `content` with `secret`. */
export type HmacHex = (secret: string, content: string) => string;

export interface StripeSignatureParts {
  timestamp: number | null;
  signatures: string[];
}

/** Splits "t=…,v1=…,v1=…"; every scheme except v1 is ignored (v0 is for test events only). */
export function parseStripeSignature(header: string): StripeSignatureParts {
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of header.split(',')) {
    const at = part.indexOf('=');
    if (at < 0) continue;
    const key = part.slice(0, at).trim();
    const value = part.slice(at + 1).trim();
    if (key === 't') timestamp = /^\d+$/.test(value) ? Number(value) : null;
    else if (key === 'v1' && value) signatures.push(value);
  }
  return { timestamp, signatures };
}

export type StripeVerifyResult = { ok: true } | { ok: false; reason: 'MALFORMED' | 'TIMESTAMP' | 'MISMATCH' };

export interface StripeVerifyInput {
  /** The raw request body exactly as received. */
  rawBody: string;
  header: string | undefined;
  /** The endpoint secret, plus the previous one during a roll. */
  secrets: string[];
  nowSeconds: number;
  hmacHex: HmacHex;
  toleranceSeconds?: number;
}

export function verifyStripeSignature(input: StripeVerifyInput): StripeVerifyResult {
  const { timestamp, signatures } = parseStripeSignature(input.header ?? '');
  if (timestamp === null || signatures.length === 0) return { ok: false, reason: 'MALFORMED' };
  const tolerance = input.toleranceSeconds ?? STRIPE_SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return { ok: false, reason: 'TIMESTAMP' };
  const signed = `${timestamp}.${input.rawBody}`;
  for (const secret of input.secrets) {
    if (!secret) continue;
    const expected = input.hmacHex(secret, signed);
    if (signatures.some((signature) => timingSafeEqualString(signature, expected))) return { ok: true };
  }
  return { ok: false, reason: 'MISMATCH' };
}

/** The header Stripe would send for `rawBody` at `timestamp` (used by the fakes and mock-meta). */
export function signStripePayload(secret: string, timestamp: number, rawBody: string, hmacHex: HmacHex): string {
  return `t=${timestamp},v1=${hmacHex(secret, `${timestamp}.${rawBody}`)}`;
}
