// USD cost estimate (FR-029, research R17, T159). Money is integer micro-dollars (bigint).
// Meta bills per delivered message by category and recipient country; the webhook `pricing`
// object says whether a message is billable and its category.

export type RateCategory = 'MARKETING' | 'UTILITY' | 'AUTHENTICATION' | 'SERVICE';

export interface RateEntry {
  category: RateCategory;
  /** ISO-2 country or "*" for the default rate. */
  countryCode: string;
  priceUsdMicros: bigint;
  effectiveFrom: Date;
}

export function usdToMicros(usd: number): bigint {
  return BigInt(Math.round(usd * 1_000_000));
}

export function microsToUsdNumber(micros: bigint): number {
  return Number(micros) / 1_000_000;
}

/** Rate lookup: the latest entry effective on the date, for the country or else the "*" default. */
export class RateTable {
  private readonly byKey = new Map<string, RateEntry[]>();

  constructor(entries: readonly RateEntry[]) {
    for (const entry of entries) {
      const key = `${entry.category}|${entry.countryCode.toUpperCase()}`;
      const list = this.byKey.get(key) ?? [];
      list.push(entry);
      this.byKey.set(key, list);
    }
    for (const list of this.byKey.values()) list.sort((a, b) => b.effectiveFrom.getTime() - a.effectiveFrom.getTime());
  }

  get isEmpty(): boolean {
    return this.byKey.size === 0;
  }

  private effective(category: RateCategory, country: string, at: Date): bigint | null {
    const list = this.byKey.get(`${category}|${country}`);
    return list?.find((e) => e.effectiveFrom.getTime() <= at.getTime())?.priceUsdMicros ?? null;
  }

  rate(category: RateCategory, country: string, at: Date = new Date()): bigint | null {
    return this.effective(category, country.toUpperCase(), at) ?? this.effective(category, '*', at);
  }
}

const CATEGORY_PREFIX: Array<[string, RateCategory]> = [
  ['marketing', 'MARKETING'],
  ['utility', 'UTILITY'],
  ['authentication', 'AUTHENTICATION'],
  ['service', 'SERVICE'],
];

/** Webhook pricing category (e.g. "marketing", "authentication-international") or the template's. */
export function rateCategory(pricingCategory: string | null | undefined, templateCategory: string): RateCategory {
  const lower = (pricingCategory ?? '').toLowerCase();
  const match = CATEGORY_PREFIX.find(([prefix]) => lower.startsWith(prefix));
  if (match) return match[1];
  return templateCategory === 'UTILITY' || templateCategory === 'AUTHENTICATION' ? templateCategory : 'MARKETING';
}

/** Billable per the webhook pricing flag when known, else when the message was delivered. */
export function isBillable(m: { billable: boolean | null; status: string }): boolean {
  if (m.billable !== null) return m.billable;
  return m.status === 'DELIVERED' || m.status === 'READ';
}

export interface CostedMessage {
  billable: boolean | null;
  status: string;
  pricingCategory: string | null;
  recipientCountry: string;
  deliveredAt: Date | null;
  readAt: Date | null;
  sentAt: Date | null;
}

/** Estimated cost of one message in micros, or null when it is not billable or has no rate. */
export function messageCost(table: RateTable, m: CostedMessage, templateCategory: string): bigint | null {
  if (!isBillable(m)) return null;
  const at = m.deliveredAt ?? m.readAt ?? m.sentAt ?? new Date();
  return table.rate(rateCategory(m.pricingCategory, templateCategory), m.recipientCountry, at);
}
