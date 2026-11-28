import { describe, expect, it } from 'vitest';
import { globalKeys, renderBodyPreview, resolveVariables } from '../../src/modules/campaigns/variable-resolver.js';

// T074: variable mapping sources, fallbacks and MISSING_VARIABLE.
const variables = [
  { key: 'BODY.1', example: 'Sara' },
  { key: 'BODY.2', example: 'Dubai' },
  { key: 'BUTTON.0.1', example: 'summer' },
];
const contact = { name: 'Ali', phone: '+971501234567', attributes: { city: 'Abu Dhabi', tier: 'gold' } };

describe('resolveVariables', () => {
  it('reads column, field, attribute and static sources', () => {
    const result = resolveVariables(
      variables,
      {
        'BODY.1': { source: 'field', key: 'name' },
        'BODY.2': { source: 'attribute', key: 'city' },
        'BUTTON.0.1': { source: 'static', value: 'winter' },
      },
      { contact, row: {} },
    );
    expect(result).toEqual({ ok: true, params: { 'BODY.1': 'Ali', 'BODY.2': 'Abu Dhabi', 'BUTTON.0.1': 'winter' } });
  });

  it('reads uploaded CSV columns', () => {
    const result = resolveVariables(
      [{ key: 'BODY.1', example: '' }],
      { 'BODY.1': { source: 'column', key: 'first_name' } },
      { contact, row: { first_name: 'Zara' } },
    );
    expect(result).toEqual({ ok: true, params: { 'BODY.1': 'Zara' } });
  });

  it('uses the fallback when the value is empty', () => {
    const result = resolveVariables(
      [{ key: 'BODY.1', example: '' }],
      { 'BODY.1': { source: 'column', key: 'first_name', fallback: 'there' } },
      { contact, row: { first_name: '   ' } },
    );
    expect(result).toEqual({ ok: true, params: { 'BODY.1': 'there' } });
  });

  it('reports missing values without a fallback', () => {
    const result = resolveVariables(
      variables,
      { 'BODY.1': { source: 'field', key: 'name' }, 'BODY.2': { source: 'attribute', key: 'unknown' } },
      { contact, row: {} },
    );
    expect(result).toEqual({ ok: false, missing: ['BODY.2', 'BUTTON.0.1'] });
  });
});

describe('resolveVariables: payment source (feature 008)', () => {
  it('reads the payment request a message carries', () => {
    const result = resolveVariables(
      [{ key: 'BODY.1' }, { key: 'BODY.2' }, { key: 'BUTTON.0.1' }, { key: 'BODY.3' }],
      { 'BODY.1': { source: 'payment', key: 'description' }, 'BODY.2': { source: 'payment', key: 'amount' }, 'BUTTON.0.1': { source: 'payment', key: 'code' }, 'BODY.3': { source: 'payment', key: 'reference', fallback: '-' } },
      { contact: { name: 'Sara', phone: '+971500000000', attributes: {} }, row: {}, payment: { description: 'Order 1042', amount: 'AED 150.00', code: 'Ab12Cd34Ef' } },
    );
    expect(result).toEqual({ ok: true, params: { 'BODY.1': 'Order 1042', 'BODY.2': 'AED 150.00', 'BUTTON.0.1': 'Ab12Cd34Ef', 'BODY.3': '-' } });
  });

  it('reports payment values as missing when no request is given', () => {
    expect(resolveVariables([{ key: 'BODY.1' }], { 'BODY.1': { source: 'payment', key: 'amount' } }, { contact: { name: null, phone: null, attributes: {} }, row: {} })).toEqual({ ok: false, missing: ['BODY.1'] });
  });
});

describe('renderBodyPreview', () => {
  it('replaces body placeholders with resolved values', () => {
    expect(renderBodyPreview('Hello {{1}}, see you in {{2}}!', { 'BODY.1': 'Ali', 'BODY.2': 'Dubai' })).toBe('Hello Ali, see you in Dubai!');
    expect(renderBodyPreview('Hi {{first_name}}', { 'BODY.first_name': 'Zara' })).toBe('Hi Zara');
  });
});

// Feature 010 (US3, T042): the `global` source reads company-wide values.
describe('resolveVariables with global attributes', () => {
  const one = [{ key: 'BODY.1', example: '9 am' }];

  it('reads a global attribute by key', () => {
    expect(resolveVariables(one, { 'BODY.1': { source: 'global', key: 'store_hours' } }, { contact, row: {}, globals: { store_hours: '9 am to 9 pm' } })).toEqual({
      ok: true,
      params: { 'BODY.1': '9 am to 9 pm' },
    });
  });

  it('treats an unknown or blank value as missing unless there is a fallback', () => {
    const mapping = { 'BODY.1': { source: 'global' as const, key: 'store_hours' } };
    expect(resolveVariables(one, mapping, { contact, row: {}, globals: { store_hours: '   ' } })).toEqual({ ok: false, missing: ['BODY.1'] });
    expect(resolveVariables(one, mapping, { contact, row: {} })).toEqual({ ok: false, missing: ['BODY.1'] });
    expect(resolveVariables(one, { 'BODY.1': { ...mapping['BODY.1'], fallback: 'all day' } }, { contact, row: {}, globals: {} })).toEqual({ ok: true, params: { 'BODY.1': 'all day' } });
  });

  it('lists the global attribute keys a mapping uses, once each', () => {
    expect(
      globalKeys({
        'BODY.1': { source: 'global', key: 'store_hours' },
        'BODY.2': { source: 'attribute', key: 'city' },
        'BODY.3': { source: 'global', key: 'store_hours' },
        'BUTTON.0.1': { source: 'global', key: 'promo_code' },
      }),
    ).toEqual(['store_hours', 'promo_code']);
    expect(globalKeys({})).toEqual([]);
  });
});
