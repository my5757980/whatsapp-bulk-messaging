import { describe, expect, it } from 'vitest';
import { validateTemplate } from '../template-rules.js';
import { SAMPLE_INDUSTRIES, SAMPLE_PURPOSES, SAMPLE_TYPES, TEMPLATE_SAMPLES, filterSamples } from './samples.js';

// T066 (feature 009 US6, research R13): the sample library.
const MISSING_FILE = /sampleMediaAssetId$|^header\.mediaAssetId$/;
// Other companies' brand words never appear in our samples (constitution Principle II).
const DENY = ['aisensy', 'wati', 'interakt', 'gupshup', 'twilio', 'zoko', 'respond.io', 'amazon', 'talabat', 'careem', 'uber', 'netflix', 'starbucks', 'ikea'];

describe('TEMPLATE_SAMPLES', () => {
  it('passes the template rules (media samples only lack their file)', () => {
    for (const s of TEMPLATE_SAMPLES) {
      const issues = validateTemplate({ ...s.draft }).filter((i) => !MISSING_FILE.test(i.field));
      expect(issues, s.id).toEqual([]);
    }
  });

  it('covers at least 60 samples, 10 industries, every purpose and type, and 10 in Arabic', () => {
    expect(TEMPLATE_SAMPLES.length).toBeGreaterThanOrEqual(60);
    expect(new Set(TEMPLATE_SAMPLES.map((s) => s.industry))).toEqual(new Set(SAMPLE_INDUSTRIES));
    expect(new Set(TEMPLATE_SAMPLES.map((s) => s.purpose))).toEqual(new Set(SAMPLE_PURPOSES));
    expect(new Set(TEMPLATE_SAMPLES.map((s) => s.type))).toEqual(new Set(SAMPLE_TYPES));
    expect(TEMPLATE_SAMPLES.filter((s) => s.language === 'ar').length).toBeGreaterThanOrEqual(10);
  });

  it('has unique ids and names, and names follow Meta\'s format', () => {
    expect(new Set(TEMPLATE_SAMPLES.map((s) => s.id)).size).toBe(TEMPLATE_SAMPLES.length);
    expect(new Set(TEMPLATE_SAMPLES.map((s) => s.name)).size).toBe(TEMPLATE_SAMPLES.length);
    for (const s of TEMPLATE_SAMPLES) {
      expect(s.id).toMatch(/^[a-z0-9-]{3,80}$/);
      expect(s.draft.name).toBe(s.name);
    }
  });

  it('keeps the category and type consistent with the draft', () => {
    for (const s of TEMPLATE_SAMPLES) {
      expect(s.draft.category, s.id).toBe(s.category);
      const kind = s.draft.kind ?? 'STANDARD';
      const expected = { TEXT: 'STANDARD', MEDIA: 'STANDARD', CAROUSEL: 'CAROUSEL', OFFER: 'LIMITED_TIME_OFFER', AUTHENTICATION: 'AUTHENTICATION' }[s.type];
      expect(kind, s.id).toBe(expected);
      if (s.type === 'MEDIA') expect(s.draft.header?.format, s.id).toMatch(/IMAGE|VIDEO|DOCUMENT/);
    }
  });

  it('contains no other company\'s brand words', () => {
    for (const s of TEMPLATE_SAMPLES) {
      const text = JSON.stringify(s).toLowerCase();
      for (const word of DENY) expect(text.includes(word), `${s.id}: ${word}`).toBe(false);
    }
  });
});

describe('filterSamples', () => {
  it('filters by industry, purpose, type and language, and searches the texts', () => {
    expect(filterSamples({ industry: 'FOOD', purpose: 'ORDER_UPDATE', language: 'en' }).map((s) => s.id)).toEqual(['food-order-update']);
    expect(filterSamples({ type: 'CAROUSEL' }).every((s) => s.draft.kind === 'CAROUSEL')).toBe(true);
    expect(filterSamples({ language: 'ar' }).length).toBeGreaterThanOrEqual(10);
    expect(filterSamples({ search: 'tenancy' }).map((s) => s.id)).toEqual(['real-estate-contract']);
  });
});
