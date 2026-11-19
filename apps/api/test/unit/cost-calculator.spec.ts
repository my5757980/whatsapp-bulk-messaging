import { describe, expect, it } from 'vitest';
import { RateTable, isBillable, messageCost, rateCategory, usdToMicros } from '../../src/modules/reports/cost-calculator.js';

// T153: USD cost estimate from the rate card (FR-029, research R17).
const d = (s: string) => new Date(`${s}T00:00:00Z`);
const table = new RateTable([
  { category: 'MARKETING', countryCode: '*', priceUsdMicros: 50_000n, effectiveFrom: d('2026-01-01') },
  { category: 'MARKETING', countryCode: 'AE', priceUsdMicros: 38_400n, effectiveFrom: d('2026-01-01') },
  { category: 'MARKETING', countryCode: 'AE', priceUsdMicros: 40_000n, effectiveFrom: d('2026-07-01') },
  { category: 'UTILITY', countryCode: '*', priceUsdMicros: 8_000n, effectiveFrom: d('2026-01-01') },
]);

describe('RateTable', () => {
  it('picks the latest rate effective on the date for the category and country', () => {
    expect(table.rate('MARKETING', 'AE', d('2026-03-15'))).toBe(38_400n);
    expect(table.rate('MARKETING', 'AE', d('2026-07-01'))).toBe(40_000n);
    expect(table.rate('MARKETING', 'AE', d('2026-11-17'))).toBe(40_000n);
  });

  it('falls back to the * default rate, and returns null without any rate', () => {
    expect(table.rate('MARKETING', 'GB', d('2026-03-15'))).toBe(50_000n);
    expect(table.rate('UTILITY', 'AE', d('2026-03-15'))).toBe(8_000n);
    expect(table.rate('AUTHENTICATION', 'AE', d('2026-03-15'))).toBeNull();
    expect(table.rate('MARKETING', 'AE', d('2025-12-31'))).toBeNull();
  });
});

describe('billing rules', () => {
  it('uses the webhook pricing flag, else bills delivered messages', () => {
    expect(isBillable({ billable: true, status: 'SENT' })).toBe(true);
    expect(isBillable({ billable: false, status: 'READ' })).toBe(false);
    expect(isBillable({ billable: null, status: 'DELIVERED' })).toBe(true);
    expect(isBillable({ billable: null, status: 'READ' })).toBe(true);
    expect(isBillable({ billable: null, status: 'SENT' })).toBe(false);
    expect(isBillable({ billable: null, status: 'FAILED' })).toBe(false);
  });

  it('maps the webhook pricing category, falling back to the template category', () => {
    expect(rateCategory('marketing', 'UTILITY')).toBe('MARKETING');
    expect(rateCategory('authentication-international', 'UTILITY')).toBe('AUTHENTICATION');
    expect(rateCategory('service', 'MARKETING')).toBe('SERVICE');
    expect(rateCategory(null, 'UTILITY')).toBe('UTILITY');
    expect(rateCategory('something_new', 'MARKETING')).toBe('MARKETING');
  });

  it('prices billable messages in integer micros', () => {
    const delivered = { billable: null, status: 'DELIVERED' as const, pricingCategory: null, recipientCountry: 'AE', deliveredAt: d('2026-08-01'), readAt: null, sentAt: d('2026-08-01') };
    expect(messageCost(table, delivered, 'MARKETING')).toBe(40_000n);
    expect(messageCost(table, { ...delivered, billable: false }, 'MARKETING')).toBeNull();
    expect(messageCost(table, { ...delivered, pricingCategory: 'utility' }, 'MARKETING')).toBe(8_000n);
    expect(usdToMicros(0.0125)).toBe(12_500n);
    expect(usdToMicros(1.1)).toBe(1_100_000n);
  });
});
