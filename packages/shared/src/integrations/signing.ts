// Outbound webhook signatures in the Standard Webhooks format (feature 006, research R1).
// Pure: the HMAC-SHA256 function is passed in (node:crypto in the api), so this module also runs in
// the browser bundle. Base64 uses atob/btoa, which Node and browsers both have.

export const WEBHOOK_SECRET_PREFIX = 'whsec_';
/** Receivers refuse timestamps further than this from their clock (the specification's default). */
export const SIGNATURE_TOLERANCE_SECONDS = 300;
const MIN_KEY_BYTES = 24;
const MAX_KEY_BYTES = 64;

/** Returns the base64 HMAC-SHA256 of `content` with `key`. */
export type Hmac = (key: Uint8Array, content: string) => string;

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** What is signed: `{webhook-id}.{webhook-timestamp}.{raw body}`. */
export function signedContent(id: string, timestamp: number | string, body: string): string {
  return `${id}.${timestamp}.${body}`;
}

export function isWebhookSecret(secret: string): boolean {
  if (!secret.startsWith(WEBHOOK_SECRET_PREFIX)) return false;
  const encoded = secret.slice(WEBHOOK_SECRET_PREFIX.length);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) return false;
  try {
    const length = fromBase64(encoded).length;
    return length >= MIN_KEY_BYTES && length <= MAX_KEY_BYTES;
  } catch {
    return false;
  }
}

/** The key behind a `whsec_` secret. Throws for anything else. */
export function secretKey(secret: string): Uint8Array {
  if (!isWebhookSecret(secret)) throw new Error('Not a webhook secret');
  return fromBase64(secret.slice(WEBHOOK_SECRET_PREFIX.length));
}

/** A new secret from random bytes (the api passes 32 from node:crypto). */
export function makeWebhookSecret(randomBytes: Uint8Array): string {
  if (randomBytes.length < MIN_KEY_BYTES || randomBytes.length > MAX_KEY_BYTES) throw new Error(`A secret needs ${MIN_KEY_BYTES} to ${MAX_KEY_BYTES} random bytes`);
  return `${WEBHOOK_SECRET_PREFIX}${toBase64(randomBytes)}`;
}

/** The `webhook-signature` header: one `v1,` value per secret (two while a secret is renewed). */
export function signatureHeader(hmac: Hmac, secrets: readonly string[], id: string, timestamp: number, body: string): string {
  const content = signedContent(id, timestamp, body);
  return secrets.map((secret) => `v1,${hmac(secretKey(secret), content)}`).join(' ');
}

/** The v1 signatures in a `webhook-signature` header; other versions are ignored. */
export function parseSignatureHeader(header: string): string[] {
  return header
    .split(' ')
    .map((part) => part.trim())
    .filter((part) => part.startsWith('v1,'))
    .map((part) => part.slice(3))
    .filter(Boolean);
}

/** Compares two strings in time that does not depend on where they differ. */
export function timingSafeEqualString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyInput {
  hmac: Hmac;
  secrets: readonly string[];
  id: string;
  timestamp: number | string;
  body: string;
  header: string;
  nowSeconds: number;
  toleranceSeconds?: number;
}

/** True when the timestamp is fresh and any signature matches any secret (the receiver's check). */
export function verifyWebhook(input: VerifyInput): boolean {
  const timestamp = Number(input.timestamp);
  if (!Number.isFinite(timestamp)) return false;
  if (Math.abs(input.nowSeconds - timestamp) > (input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS)) return false;
  const signatures = parseSignatureHeader(input.header);
  if (!signatures.length) return false;
  const content = signedContent(input.id, input.timestamp, input.body);
  const expected = input.secrets.map((secret) => input.hmac(secretKey(secret), content));
  return signatures.some((signature) => expected.some((value) => timingSafeEqualString(signature, value)));
}
