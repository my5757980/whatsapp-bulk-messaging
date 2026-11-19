import { describe, expect, it } from 'vitest';
import { renderBodyPreview, resolveVariables } from '../../src/modules/campaigns/variable-resolver.js';

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

describe('renderBodyPreview', () => {
  it('replaces body placeholders with resolved values', () => {
    expect(renderBodyPreview('Hello {{1}}, see you in {{2}}!', { 'BODY.1': 'Ali', 'BODY.2': 'Dubai' })).toBe('Hello Ali, see you in Dubai!');
    expect(renderBodyPreview('Hi {{first_name}}', { 'BODY.first_name': 'Zara' })).toBe('Hi Zara');
  });
});
