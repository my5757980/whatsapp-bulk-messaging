import { maskPhone } from '../phone/phone.js';

// Log sanitising (constitution Principle VI): no secrets, no message bodies, masked phones.

const SECRET_KEYS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'accesstoken',
  'access_token',
  'token',
  'password',
  'passwordhash',
  'password_hash',
  'secret',
  'appsecret',
  'apikey',
  'api_key',
  'x-ops-token',
  'x-csrf-token',
  'x-hub-signature-256',
]);

const CONTENT_KEYS = new Set(['text', 'messagetext', 'resolvedparams', 'templateparams', 'params', 'body_text']);

const PHONE_KEYS = new Set([
  'phone',
  'phonee164',
  'phone_e164',
  'to',
  'from',
  'recipient_id',
  'recipientid',
  'wa_id',
  'waid',
  'destination',
]);

const REDACTED = '[REDACTED]';
const MAX_DEPTH = 8;

function sanitize(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => sanitize(item, depth + 1));
  if (value instanceof Date || Buffer.isBuffer(value)) return value;

  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    const k = key.toLowerCase();
    if (SECRET_KEYS.has(k) || CONTENT_KEYS.has(k)) {
      out[key] = REDACTED;
    } else if (PHONE_KEYS.has(k) && (typeof inner === 'string' || typeof inner === 'number')) {
      out[key] = maskPhone(String(inner));
    } else {
      out[key] = sanitize(inner, depth + 1);
    }
  }
  return out;
}

/** Returns a sanitised copy; the input is never mutated. */
export function sanitizeLogObject(value: unknown): unknown {
  return sanitize(value, 0);
}
