import { describe, expect, it } from 'vitest';
import { buildSearchQuery } from '../../../src/modules/ai/knowledge/knowledge-search.js';

// T026: the text-search query sent to Postgres (research R4): words joined with OR, safe from
// tsquery syntax, English stop words dropped, other scripts kept.
describe('buildSearchQuery', () => {
  it('joins meaningful words with OR and drops English stop words and punctuation', () => {
    expect(buildSearchQuery('How much is delivery to Sharjah?')).toBe('delivery | sharjah');
    expect(buildSearchQuery('Do you have the XL corner sofa in grey, please?')).toBe('xl | corner | sofa | grey');
  });

  it('cannot carry tsquery operators', () => {
    expect(buildSearchQuery("price&(sofa)|!bed:* 'x'")).toBe('price | sofa | bed');
  });

  it('keeps Arabic words', () => {
    expect(buildSearchQuery('كم سعر التوصيل إلى الشارقة؟')).toBe('كم | سعر | التوصيل | إلى | الشارقة');
  });

  it('removes duplicates and keeps at most 12 words', () => {
    expect(buildSearchQuery('sofa sofa SOFA bed')).toBe('sofa | bed');
    const many = Array.from({ length: 20 }, (_, i) => `word${i}`).join(' ');
    expect(buildSearchQuery(many)?.split(' | ')).toHaveLength(12);
  });

  it('returns null when nothing is left to search', () => {
    expect(buildSearchQuery('')).toBeNull();
    expect(buildSearchQuery('?!...')).toBeNull();
    expect(buildSearchQuery('how is the')).toBeNull();
  });
});
