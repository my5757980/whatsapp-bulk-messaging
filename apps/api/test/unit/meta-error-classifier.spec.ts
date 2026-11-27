import { describe, expect, it } from 'vitest';
import { META_ERROR_MEANINGS } from '@wbm/shared';
import { HANDLED_META_CODES, classifyMetaError, describeMetaError } from '../../src/modules/meta/meta-error-classifier.js';

// Research R9: Meta error code -> retry policy.
describe('classifyMetaError', () => {
  it.each([130429, 131000, 131016, 133004, 4, 80007, 131056])('code %i is TRANSIENT', (code) => {
    expect(classifyMetaError(code)).toBe('TRANSIENT');
  });

  it.each([131026, 131047, 131049, 132000, 132012, 132005, 131048])('code %i is PERMANENT', (code) => {
    expect(classifyMetaError(code)).toBe('PERMANENT');
  });

  it.each([190, 10, 368, 133010, 132001, 132007, 132015, 132016])('code %i is BLOCKING', (code) => {
    expect(classifyMetaError(code)).toBe('BLOCKING');
  });

  it('treats unknown codes as PERMANENT (never retry blindly)', () => {
    expect(classifyMetaError(999999)).toBe('PERMANENT');
  });

  it('treats server errors without a code as TRANSIENT', () => {
    expect(classifyMetaError(undefined, 503)).toBe('TRANSIENT');
    expect(classifyMetaError(undefined, 400)).toBe('PERMANENT');
  });
});

describe('describeMetaError', () => {
  it('gives a readable reason for known codes', () => {
    expect(describeMetaError(131026)).toMatch(/undeliverable/i);
    expect(describeMetaError(190)).toMatch(/token/i);
  });

  it('falls back to the Meta message for unknown codes', () => {
    expect(describeMetaError(424242, 'Something odd')).toBe('Something odd (code 424242)');
  });
});

// T011 (feature 009, FR-028): every handled code has a meaning and a suggested action.
describe('error meanings coverage', () => {
  it('covers every code the classifier handles', () => {
    expect(HANDLED_META_CODES.length).toBeGreaterThan(15);
    for (const code of HANDLED_META_CODES) {
      expect(META_ERROR_MEANINGS[code], String(code)).toBeDefined();
      expect(META_ERROR_MEANINGS[code]!.action.length).toBeGreaterThan(5);
    }
  });
});
