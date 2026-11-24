import { describe, expect, it } from 'vitest';
import {
  apiNameProblem,
  callValueKeys,
  isContactField,
  mappingProblems,
  resolveApiValues,
  resolveAttributeValues,
  startOfLocalDay,
  suggestApiName,
  type ApiVariableMapping,
} from './api-campaigns.js';

// T034 (feature 006 US3, FR-017 - FR-020, research R6): API campaign names, value sources and the
// daily limit's day.
describe('API campaign rules', () => {
  it('accepts lower-case API names of 3 to 60 characters and suggests one from the campaign name', () => {
    expect(apiNameProblem('order-feedback')).toBeNull();
    expect(apiNameProblem('otp2')).toBeNull();
    for (const bad of ['Order', 'ab', '-order', 'order-', 'order feedback', 'ordér', 'a'.repeat(61)]) expect(apiNameProblem(bad), bad).not.toBeNull();
    expect(suggestApiName('Order feedback!')).toBe('order-feedback');
    expect(suggestApiName('  Café   Reminders 2 ')).toBe('cafe-reminders-2');
    expect(suggestApiName('A')).toBe('a-campaign');
    expect(suggestApiName('###')).toBe('campaign');
    expect(apiNameProblem(suggestApiName('x'.repeat(80)))).toBeNull();
  });

  const variables = ['BODY.1', 'BODY.2', 'BODY.3', 'BUTTON.0.1'];
  const mapping: ApiVariableMapping = {
    'BODY.1': { source: 'field', key: 'name' },
    'BODY.2': { source: 'value', key: 'order' },
    'BODY.3': { source: 'static', value: 'Thanks!' },
    'BUTTON.0.1': { source: 'field', key: 'attributes.city' },
  };
  const contact = { name: 'Sara', phone: '+971501234567', attributes: { city: 'Dubai', orders: 3 } };

  it('resolves each variable from a call value, a contact field or fixed text', () => {
    expect(resolveApiValues(variables, mapping, { order: ' A-1001 ' }, contact)).toEqual({
      ok: true,
      params: { 'BODY.1': 'Sara', 'BODY.2': 'A-1001', 'BODY.3': 'Thanks!', 'BUTTON.0.1': 'Dubai' },
    });
    expect(resolveApiValues(['BODY.1'], { 'BODY.1': { source: 'field', key: 'attributes.orders' } }, {}, contact)).toEqual({ ok: true, params: { 'BODY.1': '3' } });
    expect(resolveApiValues(['BODY.1'], { 'BODY.1': { source: 'field', key: 'phone' } }, {}, contact)).toEqual({ ok: true, params: { 'BODY.1': '+971501234567' } });
  });

  it('names the missing call value, or the empty contact field', () => {
    expect(resolveApiValues(variables, mapping, {}, contact)).toEqual({ ok: false, variable: 'BODY.2', missing: 'order', from: 'value' });
    expect(resolveApiValues(variables, mapping, { order: '   ' }, contact)).toMatchObject({ ok: false, missing: 'order' });
    expect(resolveApiValues(variables, mapping, { order: '1' }, { ...contact, name: null })).toEqual({ ok: false, variable: 'BODY.1', missing: 'name', from: 'field' });
    expect(resolveApiValues(['BODY.9'], mapping, {}, contact)).toEqual({ ok: false, variable: 'BODY.9', missing: 'BODY.9', from: 'mapping' });
  });

  it('lists the problems that keep a campaign from going live', () => {
    expect(mappingProblems(variables, mapping)).toEqual([]);
    expect(
      mappingProblems(['BODY.1', 'BODY.2', 'BODY.3', 'BODY.4'], {
        'BODY.2': { source: 'value', key: 'Order Id' },
        'BODY.3': { source: 'static', value: '  ' },
        'BODY.4': { source: 'field', key: 'email' },
        'BODY.7': { source: 'static', value: 'x' },
      }),
    ).toEqual([
      'BODY.1 has no value source',
      'BODY.2: "Order Id" is not a valid value name (lower-case letters, digits and _)',
      'BODY.3 has empty fixed text',
      'BODY.4: "email" is not a contact field',
      'BODY.7 is not a variable of this template',
    ]);
    expect(isContactField('name')).toBe(true);
    expect(isContactField('attributes.city')).toBe(true);
    expect(isContactField('attributes.')).toBe(false);
  });

  it('takes attribute values from fixed values or from call values, skipping values the call left out', () => {
    expect(resolveAttributeValues({ source: 'shop', orders: 2, product: { fromValue: 'product' }, note: { fromValue: 'note' } }, { product: ' Shoes ' })).toEqual({
      source: 'shop',
      orders: 2,
      product: 'Shoes',
    });
    expect(callValueKeys(mapping, { product: { fromValue: 'product' }, source: 'shop' })).toEqual(['order', 'product']);
  });

  it('counts the daily limit from midnight in the company time zone', () => {
    // Dubai is UTC+4 all year.
    expect(startOfLocalDay(new Date('2026-11-24T21:30:00.123Z'), 'Asia/Dubai').toISOString()).toBe('2026-11-24T20:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-11-24T19:59:59Z'), 'Asia/Dubai').toISOString()).toBe('2026-11-23T20:00:00.000Z');
    expect(startOfLocalDay(new Date('2026-11-24T00:00:00Z'), 'UTC').toISOString()).toBe('2026-11-24T00:00:00.000Z');
    // New York moves to summer time at 02:00 on 8 March 2026; that day starts at 05:00 UTC.
    expect(startOfLocalDay(new Date('2026-03-08T15:00:00Z'), 'America/New_York').toISOString()).toBe('2026-03-08T05:00:00.000Z');
  });
});
