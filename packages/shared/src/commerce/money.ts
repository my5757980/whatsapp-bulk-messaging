// Money for payments (feature 008, research R5): integer minor units of the Stripe connection
// currency. Pure; runs in the api and the browser.

/** Stripe's zero- and three-decimal currencies (docs.stripe.com/currencies); every other one has 2. */
const ZERO_DECIMAL = new Set(['bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf', 'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf']);
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/**
 * Stripe's minimum charge in minor units for the currencies we expect (AED 2.00 is documented for UAE
 * accounts). Other currencies fall back to half a unit (verify against docs.stripe.com/currencies).
 */
const MINIMUM_MINOR: Record<string, number> = { aed: 200, usd: 50, eur: 50, gbp: 30, sar: 200, jpy: 50 };

export function currencyExponent(currency: string): number {
  const code = currency.toLowerCase();
  if (ZERO_DECIMAL.has(code)) return 0;
  if (THREE_DECIMAL.has(code)) return 3;
  return 2;
}

/** An amount in major units (150.5) to integer minor units (15050), rounding away float noise. */
export function toMinorUnits(amount: number, currency: string): number {
  const factor = 10 ** currencyExponent(currency);
  return Math.round(Number((amount * factor).toFixed(6)));
}

export function fromMinorUnits(minor: number, currency: string): number {
  return minor / 10 ** currencyExponent(currency);
}

export function minimumMinor(currency: string): number {
  const code = currency.toLowerCase();
  return MINIMUM_MINOR[code] ?? Math.max(1, Math.round(0.5 * 10 ** currencyExponent(code)));
}

/** Minor units to an amount with the currency's own decimals, for display (plain spaces, so messages compare and copy cleanly). */
export function formatMinor(minor: number, currency: string, locale = 'en'): string {
  const format = new Intl.NumberFormat(locale, { style: 'currency', currency: currency.toUpperCase() });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(minor / 10 ** digits).replace(/[\u00a0\u202f]/g, ' ');
}
