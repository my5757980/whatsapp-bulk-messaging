import { describe, expect, it } from 'vitest';
import { formatMinor as formatFromAds } from '../ads/budgets.js';
import { currencyExponent, formatMinor, fromMinorUnits, minimumMinor, toMinorUnits } from './money.js';

// T007 (feature 008, research R5): money in integer minor units of the Stripe connection currency.
describe('commerce money', () => {
  it('knows the minor-unit exponent of each currency (Stripe zero- and three-decimal lists)', () => {
    expect(currencyExponent('aed')).toBe(2);
    expect(currencyExponent('AED')).toBe(2);
    expect(currencyExponent('usd')).toBe(2);
    expect(currencyExponent('kwd')).toBe(3);
    expect(currencyExponent('bhd')).toBe(3);
    expect(currencyExponent('omr')).toBe(3);
    expect(currencyExponent('jpy')).toBe(0);
  });

  it('converts between major and minor units without float drift', () => {
    expect(toMinorUnits(150, 'aed')).toBe(15000);
    expect(toMinorUnits(1234.5, 'aed')).toBe(123450);
    expect(toMinorUnits(0.1 + 0.2, 'aed')).toBe(30);
    expect(toMinorUnits(1.234, 'kwd')).toBe(1234);
    expect(toMinorUnits(500, 'jpy')).toBe(500);
    expect(fromMinorUnits(15000, 'aed')).toBe(150);
    expect(fromMinorUnits(1234, 'kwd')).toBe(1.234);
  });

  it('formats with plain spaces, as the 007 formatter did', () => {
    expect(formatMinor(15000, 'AED')).toBe('AED 150.00');
    expect(formatMinor(123450, 'aed')).toBe('AED 1,234.50');
    expect(formatMinor(1000, 'USD')).toBe('$10.00');
    expect(formatMinor(15000, 'AED')).not.toMatch(/[\u00a0\u202f]/);
  });

  it('keeps the 007 import working (ads/budgets re-exports the same formatter)', () => {
    expect(formatFromAds).toBe(formatMinor);
  });

  it("uses Stripe's minimum charge (AED 2.00) and a half unit for currencies not listed (verify)", () => {
    expect(minimumMinor('aed')).toBe(200);
    expect(minimumMinor('AED')).toBe(200);
    expect(minimumMinor('usd')).toBe(50);
    expect(minimumMinor('kwd')).toBe(500);
    expect(minimumMinor('jpy')).toBe(50);
  });
});
