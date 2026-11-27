// The flow_token sent with a form (feature 008, research R12): it names the form version, the contact
// and where the form was sent, holds no personal data, and is signed by the api (HMAC with
// TOKEN_ENCRYPTION_KEY). Format: wf1.<version><contact><ref><refId>.<mac>, with ids as 32 hex digits.
// Pure; the signer is passed in.
import { timingSafeEqualString } from '../integrations/signing.js';

export const FORM_TOKEN_PREFIX = 'wf1';
const REF_CODES = { chat: 'c', message: 'm', session: 's', recipient: 'r' } as const;
export type FormTokenRef = keyof typeof REF_CODES;
const REF_OF: Record<string, FormTokenRef> = { c: 'chat', m: 'message', s: 'session', r: 'recipient' };

export interface FormTokenPayload {
  versionId: string;
  contactId: string;
  ref: FormTokenRef;
  refId: string;
}

/** Returns a URL-safe MAC of `content` (the api uses 16 bytes of HMAC-SHA256 as base64url). */
export type TokenSigner = (content: string) => string;

const hex = (uuid: string) => uuid.replace(/-/g, '').toLowerCase();
const uuid = (h: string) => `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const TOKEN = /^wf1\.([0-9a-f]{32})([0-9a-f]{32})([cmsr])([0-9a-f]{32})\.([A-Za-z0-9_-]{16,64})$/;

export function encodeFormToken(payload: FormTokenPayload, sign: TokenSigner): string {
  for (const id of [payload.versionId, payload.contactId, payload.refId]) {
    if (!UUID.test(id)) throw new Error('form token ids must be UUIDs');
  }
  const body = `${FORM_TOKEN_PREFIX}.${hex(payload.versionId)}${hex(payload.contactId)}${REF_CODES[payload.ref]}${hex(payload.refId)}`;
  return `${body}.${sign(body)}`;
}

/** The payload of a token we signed, or null for anything else (forged, changed or foreign). */
export function decodeFormToken(token: string, sign: TokenSigner): FormTokenPayload | null {
  const match = TOKEN.exec(token);
  if (!match) return null;
  const [, version, contact, ref, refId, mac] = match as unknown as [string, string, string, string, string, string];
  const body = token.slice(0, token.lastIndexOf('.'));
  if (!timingSafeEqualString(mac, sign(body))) return null;
  const refName = REF_OF[ref];
  if (!refName) return null;
  return { versionId: uuid(version), contactId: uuid(contact), ref: refName, refId: uuid(refId) };
}
