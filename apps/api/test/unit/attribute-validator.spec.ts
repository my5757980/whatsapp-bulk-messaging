import { describe, expect, it } from 'vitest';
import { validateAttributeValue } from '../../src/modules/contacts/attribute-validator.js';

// T121: typed attribute values (FR-011).
describe('validateAttributeValue', () => {
  it('accepts and normalises each type', () => {
    expect(validateAttributeValue('TEXT', '  Dubai ')).toEqual({ ok: true, value: 'Dubai' });
    expect(validateAttributeValue('TEXT', 42)).toEqual({ ok: true, value: '42' });
    expect(validateAttributeValue('NUMBER', '1,250.50')).toEqual({ ok: true, value: 1250.5 });
    expect(validateAttributeValue('NUMBER', 7)).toEqual({ ok: true, value: 7 });
    expect(validateAttributeValue('DATE', '2026-03-09')).toEqual({ ok: true, value: '2026-03-09' });
    expect(validateAttributeValue('DATE', '2026-03-09T23:10:00Z')).toEqual({ ok: true, value: '2026-03-09' });
    for (const yes of [true, 'yes', 'Y', 'TRUE', '1']) expect(validateAttributeValue('BOOLEAN', yes)).toEqual({ ok: true, value: true });
    for (const no of [false, 'no', 'n', 'false', '0']) expect(validateAttributeValue('BOOLEAN', no)).toEqual({ ok: true, value: false });
  });

  it('rejects values that do not match the type', () => {
    expect(validateAttributeValue('NUMBER', 'twelve')).toMatchObject({ ok: false });
    expect(validateAttributeValue('NUMBER', '')).toMatchObject({ ok: false });
    expect(validateAttributeValue('DATE', '09/03/2026')).toMatchObject({ ok: false, issue: expect.stringMatching(/YYYY-MM-DD/) });
    expect(validateAttributeValue('DATE', '2026-02-30')).toMatchObject({ ok: false });
    expect(validateAttributeValue('BOOLEAN', 'maybe')).toMatchObject({ ok: false });
    expect(validateAttributeValue('TEXT', 'x'.repeat(501))).toMatchObject({ ok: false });
    expect(validateAttributeValue('TEXT', { nested: true })).toMatchObject({ ok: false });
  });
});
