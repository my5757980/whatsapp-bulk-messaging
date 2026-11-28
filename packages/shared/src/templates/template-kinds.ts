// Feature 009 (research R6, R7, R9): campaign mapping keys for the new template kinds, and the payload of
// carousel card quick replies.

/** Mapping key of a header media address (one, a column or an attribute), resolved to `$headerMediaUrl`. */
export const HEADER_MEDIA_KEY = 'HEADER.media';
/** Resolved per-recipient offer code (limited-time offers). */
export const OFFER_CODE_PARAM = '$offerCode';

/** Carousel variable keys, in the 001 format: CARD.c.BODY.n and CARD.c.BUTTON.b.n (zero-based c and b). */
export const cardBodyKey = (card: number, n: number | string) => `CARD.${card}.BODY.${n}`;
export const cardButtonKey = (card: number, button: number, n: number | string = 1) => `CARD.${card}.BUTTON.${button}.${n}`;

const CARD_KEY = /^CARD\.(\d+)\.BODY\.([A-Za-z0-9_]+)$|^CARD\.(\d+)\.BUTTON\.(\d+)\.([A-Za-z0-9_]+)$/;

/** Splits a card variable key, or null when the key is not a card key. */
export function parseCardKey(key: string): { card: number; part: 'BODY'; placeholder: string } | { card: number; part: 'BUTTON'; button: number; placeholder: string } | null {
  const m = CARD_KEY.exec(key);
  if (!m) return null;
  if (m[1] !== undefined) return { card: Number(m[1]), part: 'BODY', placeholder: m[2]! };
  return { card: Number(m[3]), part: 'BUTTON', button: Number(m[4]), placeholder: m[5]! };
}

/** Quick reply payload of a carousel card button: `wbm:c{card}:b{button}` (zero-based). */
export function cardReplyPayload(card: number, button: number): string {
  return `wbm:c${card}:b${button}`;
}

/** The card and button of a quick reply payload, or null for any other payload. */
export function parseCardReplyPayload(payload: string | null | undefined): { cardIndex: number; buttonIndex: number } | null {
  const m = /^wbm:c(\d{1,2}):b(\d)$/.exec(payload ?? '');
  if (!m) return null;
  const cardIndex = Number(m[1]);
  const buttonIndex = Number(m[2]);
  return cardIndex <= 9 && buttonIndex <= 1 ? { cardIndex, buttonIndex } : null;
}
