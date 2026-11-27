// Feature 009 (research R6, R7, R9): campaign mapping keys for the new template kinds, and the payload of
// carousel card quick replies.
import { bodyPlaceholders, kindOf, type TemplateDraft } from '../template-rules.js';

/** Mapping key of a header media address (one, a column or an attribute), resolved to `$headerMediaUrl`. */
export const HEADER_MEDIA_KEY = 'HEADER.media';
/** Resolved per-recipient offer code (limited-time offers). */
export const OFFER_CODE_PARAM = '$offerCode';

export const cardBodyKey = (card: number, n: number | string) => `CARD.${card}.BODY.${n}`;
export const cardButtonKey = (card: number, button: number) => `CARD.${card}.BUTTON.${button}`;

const CARD_KEY = /^CARD\.(\d+)\.(BODY|BUTTON)\.(\d+)$/;

/** Splits a card mapping key, or null when the key is not a card key. */
export function parseCardKey(key: string): { card: number; part: 'BODY' | 'BUTTON'; index: number } | null {
  const m = CARD_KEY.exec(key);
  return m ? { card: Number(m[1]), part: m[2] as 'BODY' | 'BUTTON', index: Number(m[3]) } : null;
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

const urlVariable = (url: string | undefined) => /\{\{\s*1\s*\}\}$/.test(url ?? '');

/**
 * The variable mapping keys a campaign must fill for a template draft, in display order:
 * `HEADER.1`, `HEADER.media` (media headers when the address comes from the campaign), `BODY.n`,
 * `BUTTON.b` (URL buttons with a variable), and for carousels `CARD.i.BODY.n` and `CARD.i.BUTTON.b`.
 * Authentication templates need none (the code comes from the API); offers also need the offer code.
 */
export function requiredMappingKeys(draft: TemplateDraft, opts: { mediaFromAddress?: boolean } = {}): string[] {
  const kind = kindOf(draft);
  if (kind === 'AUTHENTICATION') return [];
  const keys: string[] = [];
  const header = draft.header;
  if (header?.format === 'TEXT' && bodyPlaceholders(header.text ?? '').length) keys.push('HEADER.1');
  if (header && header.format !== 'TEXT' && opts.mediaFromAddress) keys.push(HEADER_MEDIA_KEY);
  for (const n of bodyPlaceholders(draft.body.text ?? '')) keys.push(`BODY.${n}`);
  (draft.buttons ?? []).forEach((button, b) => {
    if (button.type === 'URL' && urlVariable(button.url)) keys.push(`BUTTON.${b}`);
  });
  if (kind === 'CAROUSEL') {
    (draft.cards ?? []).forEach((card, i) => {
      for (const n of bodyPlaceholders(card.bodyText ?? '')) keys.push(cardBodyKey(i, n));
      card.buttons.forEach((button, b) => {
        if (button.type === 'URL' && urlVariable(button.url)) keys.push(cardButtonKey(i, b));
      });
    });
  }
  if (kind === 'LIMITED_TIME_OFFER') keys.push(OFFER_CODE_PARAM);
  return keys;
}
