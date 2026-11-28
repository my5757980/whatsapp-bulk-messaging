import { describe, expect, it } from 'vitest';
import { LEAD_SOURCE_KINDS, LEAD_SOURCE_LABELS, leadSourceText, legacyLeadSource } from './lead-source.js';

// T007 (feature 010, research R5): lead source kinds and the mapping of the old free text.
describe('legacyLeadSource', () => {
  it('maps the values written before feature 010', () => {
    expect(legacyLeadSource('API')).toEqual({ kind: 'API', label: null });
    expect(legacyLeadSource('Campaign upload')).toEqual({ kind: 'CAMPAIGN_UPLOAD', label: null });
    expect(legacyLeadSource('STORE')).toEqual({ kind: 'STORE', label: null });
    expect(legacyLeadSource('Lead form')).toEqual({ kind: 'LEAD_FORM', label: null });
    expect(legacyLeadSource(' Organic ')).toEqual({ kind: 'ORGANIC', label: null });
    expect(legacyLeadSource('Import')).toEqual({ kind: 'IMPORT', label: null });
  });

  it('keeps other text as a custom label, and empty values as unknown', () => {
    expect(legacyLeadSource('Expo 2026')).toEqual({ kind: 'CUSTOM', label: 'Expo 2026' });
    expect(legacyLeadSource('')).toEqual({ kind: 'UNKNOWN', label: null });
    expect(legacyLeadSource(null)).toEqual({ kind: 'UNKNOWN', label: null });
  });
});

describe('lead source labels', () => {
  it('names every kind and joins a label', () => {
    for (const kind of LEAD_SOURCE_KINDS) expect(LEAD_SOURCE_LABELS[kind]).toBeTruthy();
    expect(leadSourceText('IMPORT', 'Expo leads')).toBe('Import · Expo leads');
    expect(leadSourceText('CUSTOM', 'Referral')).toBe('Referral');
    expect(leadSourceText('ORGANIC', null)).toBe('Wrote to us first');
  });
});
