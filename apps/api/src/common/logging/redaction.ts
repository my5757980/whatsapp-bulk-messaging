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
  // Browser push subscriptions (feature 002): the endpoint and keys let anyone send alerts.
  'endpoint',
  'keys',
  'p256dh',
  'auth',
  // Chatbot flow secrets (feature 003): stored values of API step header secrets.
  'valueencrypted',
  'value_encrypted',
  'secretvalue',
]);

const CONTENT_KEYS = new Set([
  'text',
  'messagetext',
  'resolvedparams',
  'templateparams',
  'params',
  'body_text',
  // Live chat (feature 002): captions, notes, list previews, rendered templates, automatic messages.
  'caption',
  'note',
  'preview',
  'lastmessagepreview',
  'last_message_preview',
  'renderedtext',
  'welcomecontent',
  'offhourscontent',
  // Chatbot flows (feature 003): what customers answered, and reply fields an API step mapped.
  'answers',
  'mapped',
  // AI agent (feature 004, T106): prompts, knowledge, replies, hand-over summaries and remembered values.
  'prompt',
  'system',
  'knowledge',
  'chunks',
  'question',
  'answer',
  'reply',
  'summary',
  'remember',
  'remembered',
  'pendingconfirmation',
  'pending_confirmation',
  // Campaign growth (feature 005, FR-041): a tracked-link code opens its recipient's link and counts
  // a click, and a destination can carry personal values.
  'linkcode',
  'link_code',
  'linkcodes',
  'link_codes',
  'trackedurl',
  'tracked_url',
  'destination',
  'destinations',
]);

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
]);

/** Keys whose string values are paths or addresses: tracked-link codes in them are hidden (005). */
const PATH_KEYS = new Set(['url', 'path', 'originalurl']);
const LINK_PATH = /\/l\/[^/?#\s]+/g;

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
    } else if (PATH_KEYS.has(k) && typeof inner === 'string') {
      out[key] = redactLinkPaths(inner);
    } else {
      out[key] = sanitize(inner, depth + 1);
    }
  }
  return out;
}

function redactLinkPaths(value: string): string {
  return value.replace(LINK_PATH, `/l/${REDACTED}`);
}

/** A request path for the logs: no query string (it can carry secrets) and no tracked-link code. */
export function redactRequestPath(url: string): string {
  return redactLinkPaths(url.split('?')[0] ?? '');
}

/** Returns a sanitised copy; the input is never mutated. */
export function sanitizeLogObject(value: unknown): unknown {
  return sanitize(value, 0);
}
