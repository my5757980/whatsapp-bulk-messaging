import { describe, expect, it } from 'vitest';
import { looksSensitive, maskSensitive } from './masking.js';

// T012: sensitive numbers never reach the AI service (research R12, Meta's rule on sensitive identifiers).
describe('maskSensitive', () => {
  it('replaces card numbers that pass the Luhn check, with or without separators', () => {
    expect(maskSensitive('my card is 4111111111111111 thanks')).toBe('my card is [card number removed] thanks');
    expect(maskSensitive('4111 1111 1111 1111')).toBe('[card number removed]');
    expect(maskSensitive('5555-5555-5555-4444 exp 12/29')).toBe('[card number removed] exp 12/29');
  });

  it('leaves digit runs that are not card numbers, and phone numbers', () => {
    expect(maskSensitive('order 1234567890123 please')).toBe('order 1234567890123 please');
    expect(maskSensitive('call me on +971501234567')).toBe('call me on +971501234567');
    expect(maskSensitive('+97150123456789')).toBe('+97150123456789');
    expect(maskSensitive('AED 1,000 for 2 sofas')).toBe('AED 1,000 for 2 sofas');
  });

  it('replaces Emirates ID numbers with or without dashes', () => {
    expect(maskSensitive('ID 784-1990-1234567-1')).toBe('ID [ID number removed]');
    expect(maskSensitive('784199012345671')).toBe('[ID number removed]');
  });

  it('replaces UAE IBANs, spaced or not', () => {
    expect(maskSensitive('IBAN AE070331234567890123456')).toBe('IBAN [bank account removed]');
    expect(maskSensitive('ae07 0331 2345 6789 0123 456')).toBe('[bank account removed]');
  });
});

describe('looksSensitive', () => {
  it('agrees with maskSensitive', () => {
    expect(looksSensitive('4111111111111111')).toBe(true);
    expect(looksSensitive('784-1990-1234567-1')).toBe(true);
    expect(looksSensitive('Al Ain')).toBe(false);
    expect(looksSensitive('+971501234567')).toBe(false);
  });
});
