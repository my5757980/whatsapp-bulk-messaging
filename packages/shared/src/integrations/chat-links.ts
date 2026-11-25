// Chat links and QR codes (feature 006 US7, FR-045 - FR-050, research R12): the reference that the
// pre-filled message carries, the wa.me address, and finding the reference in the customer's message.

/** Letters and digits without look-alikes (no 0/O, 1/I/L). */
export const CHAT_REF_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export const CHAT_REF_LENGTH = 6;
export const CHAT_LINK_MESSAGE_MAX = 500;

export function makeChatRef(randomIndex: (max: number) => number): string {
  let ref = '';
  for (let i = 0; i < CHAT_REF_LENGTH; i += 1) ref += CHAT_REF_ALPHABET[randomIndex(CHAT_REF_ALPHABET.length)];
  return ref;
}

export function isChatRef(value: string): boolean {
  return value.length === CHAT_REF_LENGTH && [...value].every((c) => CHAT_REF_ALPHABET.includes(c));
}

/** The pre-filled text: the link's message, then " (ref ABC123)". */
export function messageWithRef(message: string, ref: string): string {
  return `${message.trim().slice(0, CHAT_LINK_MESSAGE_MAX)} (ref ${ref})`;
}

/** https://wa.me/{digits}?text={encoded}: digits only, as WhatsApp asks. */
export function waMeUrl(phone: string, text: string): string {
  return `https://wa.me/${phone.replace(/\D/g, '')}?text=${encodeURIComponent(text)}`;
}

/** The short link: `${base}/c/{code}`, answered by the api at /l/c/:code. */
export function chatLinkUrl(base: string, code: string): string {
  return `${base.replace(/\/+$/, '')}/c/${code}`;
}

const REF = /\(ref ([A-Za-z0-9]{6})\)/g;

/** The last "(ref XXXXXX)" in a message; null when there is none or it was edited out of the alphabet. */
export function findChatRef(text: string | null | undefined): string | null {
  if (!text) return null;
  const matches = [...text.matchAll(REF)];
  const last = matches[matches.length - 1]?.[1]?.toUpperCase();
  return last && isChatRef(last) ? last : null;
}
