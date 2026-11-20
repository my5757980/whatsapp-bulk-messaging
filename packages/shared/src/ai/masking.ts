// Sensitive numbers are removed from customer text before it reaches the AI service, and remembered
// values that look like them are refused (research R12; Meta's Business Messaging Policy §3 forbids
// asking for card, bank account or ID numbers). Phone numbers are left alone.

const EMIRATES_ID = /\b784[- ]?\d{4}[- ]?\d{7}[- ]?\d\b/g;
const UAE_IBAN = /\bAE\d{2}(?:\s?\d){19}\b/gi;
/** 13–19 digits, optionally in groups split by single spaces or dashes; not after "+" (phone numbers). */
const CARD_CANDIDATE = /(?<![+\d])\d(?:[ -]?\d){12,18}(?!\d)/g;

export const MASKS = {
  card: '[card number removed]',
  id: '[ID number removed]',
  bank: '[bank account removed]',
} as const;

function passesLuhn(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (double) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replaces Emirates ID numbers, UAE IBANs and Luhn-valid card numbers with readable markers. */
export function maskSensitive(text: string): string {
  return text
    .replace(EMIRATES_ID, MASKS.id)
    .replace(UAE_IBAN, MASKS.bank)
    .replace(CARD_CANDIDATE, (match) => {
      const digits = match.replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && passesLuhn(digits) ? MASKS.card : match;
    });
}

/** True when the value holds something maskSensitive would remove. */
export function looksSensitive(value: string): boolean {
  return maskSensitive(value) !== value;
}
