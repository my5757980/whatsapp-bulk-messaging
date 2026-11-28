import { describe, expect, it } from 'vitest';
import { GLOBAL_KEY, GlobalAttributeCreateSchema, fillGlobals } from '../../src/modules/settings/global-attributes.service.js';

// Feature 010 (US3, T042): the key pattern and filling AI agent instructions.
describe('global attributes', () => {
  it('accepts lower-case keys of up to 40 characters', () => {
    expect(GLOBAL_KEY.test('store_hours')).toBe(true);
    expect(GLOBAL_KEY.test('a'.repeat(40))).toBe(true);
    for (const bad of ['Store', '1st', '_x', 'store-hours', 'a'.repeat(41), '']) expect(GLOBAL_KEY.test(bad)).toBe(false);
    expect(GlobalAttributeCreateSchema.safeParse({ key: 'Store Hours', value: '9 am' }).success).toBe(false);
    expect(GlobalAttributeCreateSchema.safeParse({ key: 'store_hours', value: '9 am', extra: 1 }).success).toBe(false);
  });

  it('fills placeholders and leaves unknown or empty values out', () => {
    const globals = { store_hours: '9 am to 9 pm', empty_one: '' };
    expect(fillGlobals('Open {global:store_hours}; {global:empty_one}{global:unknown}.', globals)).toBe('Open 9 am to 9 pm; .');
    expect(fillGlobals('No placeholders {first_name}', globals)).toBe('No placeholders {first_name}');
    expect(fillGlobals('{global:store_hours} and {global:store_hours}', globals)).toBe('9 am to 9 pm and 9 am to 9 pm');
  });
});
