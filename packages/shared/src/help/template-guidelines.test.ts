import { describe, expect, it } from 'vitest';
import { failureHelp, META_ERROR_MEANINGS, GENERAL_ADVICE } from './error-meanings.js';
import { GUIDELINE_SECTIONS, REJECTION_REASONS, TEMPLATE_GUIDELINES } from './template-guidelines.js';

// T073 (feature 009 US7, research R12): editor guidelines and failure help.
describe('TEMPLATE_GUIDELINES', () => {
  it('has guidelines and a checkedAt for every editor section', () => {
    expect(Object.keys(TEMPLATE_GUIDELINES).sort()).toEqual([...GUIDELINE_SECTIONS].sort());
    for (const section of GUIDELINE_SECTIONS) {
      const entry = TEMPLATE_GUIDELINES[section];
      expect(entry.title.length, section).toBeGreaterThan(3);
      expect(entry.points.length, section).toBeGreaterThanOrEqual(2);
      expect(entry.checkedAt, section).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('lists the common rejection reasons', () => {
    expect(REJECTION_REASONS.length).toBeGreaterThanOrEqual(5);
    for (const r of REJECTION_REASONS) expect(r.points.length).toBeGreaterThan(0);
  });
});

describe('failureHelp', () => {
  it('explains known Meta codes and platform reasons, and gives general advice otherwise', () => {
    expect(failureHelp(131026, 'Message undeliverable')).toEqual({ meaning: META_ERROR_MEANINGS[131026]!.meaning, action: META_ERROR_MEANINGS[131026]!.action, known: true });
    expect(failureHelp(null, 'unknown_outcome_not_retried')).toMatchObject({ known: true, action: expect.stringContaining('nothing else') });
    expect(failureHelp(139999, 'Some new problem')).toEqual({ meaning: 'Some new problem', action: GENERAL_ADVICE, known: false });
    expect(failureHelp(null, null)).toBeNull();
  });
});
