import { describe, expect, it } from 'vitest';
import { parameterCount, renderCanned } from '../../../src/modules/inbox/canned/canned-render.js';

// T056: saved-reply variables and parameters (FR-030, FR-031, data-model canned_messages).
const contact = { name: 'Sara Khan', phoneE164: '+971500000001', attributes: { city: 'Dubai', tier: 2 } };
const nameless = { name: null, phoneE164: '+971500000002', attributes: {} };

describe('renderCanned', () => {
  it('fills the contact variables', () => {
    expect(renderCanned('Hi {first_name} {last_name} ({name}), we will call {phone}', contact)).toEqual({
      ok: true,
      text: 'Hi Sara Khan (Sara Khan), we will call +971500000001',
    });
  });

  it('uses the fallback when a value is missing, otherwise leaves it blank', () => {
    expect(renderCanned('Hi {first_name}!', nameless, { first_name: 'there' })).toEqual({ ok: true, text: 'Hi there!' });
    expect(renderCanned('Hi {first_name}!', nameless)).toEqual({ ok: true, text: 'Hi !' });
    expect(renderCanned('Hi {last_name}.', { ...contact, name: 'Sara' }, { last_name: 'friend' })).toEqual({ ok: true, text: 'Hi friend.' });
  });

  it('reads attributes as text, with their own fallbacks', () => {
    expect(renderCanned('{attr:city} / {attr:tier} / {attr:zone}', contact, { 'attr:zone': 'n/a' })).toEqual({ ok: true, text: 'Dubai / 2 / n/a' });
  });

  it('needs every numbered parameter', () => {
    expect(renderCanned('Order {{1}} ships {{2}}; ref {{1}}', contact, {}, { '1': '#55', '2': 'today' })).toEqual({ ok: true, text: 'Order #55 ships today; ref #55' });
    expect(renderCanned('Order {{1}} ships {{2}}', contact, {}, { '1': '#55' })).toEqual({ ok: false, missing: ['2'] });
    expect(renderCanned('Order {{1}}', contact, {}, { '1': '   ' })).toEqual({ ok: false, missing: ['1'] });
  });

  it('keeps WhatsApp formatting and leaves unknown placeholders alone', () => {
    expect(renderCanned('*Bold* _it_ ~st~ ```mono``` {unknown} {{x}} {attr:}', contact)).toEqual({ ok: true, text: '*Bold* _it_ ~st~ ```mono``` {unknown} {{x}} {attr:}' });
  });
});

describe('parameterCount', () => {
  it('counts distinct numbered parameters by their highest number', () => {
    expect(parameterCount('Order {{1}} ships {{2}}, again {{1}}')).toBe(2);
    expect(parameterCount('No parameters, only {first_name}')).toBe(0);
    expect(parameterCount('Gap {{3}}')).toBe(3);
  });
});
