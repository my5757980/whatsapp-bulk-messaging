import { describe, expect, it } from 'vitest';
import { normalizePhrase, phraseMatches, pickKeywordTrigger, type KeywordCandidate, unsafePatternReason } from './triggers.js';

// 003 T016: keyword normalisation and the matching order (FR-019, FR-020).
const candidate = (over: Partial<KeywordCandidate>): KeywordCandidate => ({
  flowId: 'f1',
  triggerKey: 'kw',
  match: 'CONTAINS',
  phrase: 'hours',
  priority: 100,
  flowCreatedAt: '2026-11-01T00:00:00Z',
  canInterrupt: false,
  ...over,
});

describe('normalizePhrase', () => {
  it('ignores case and extra spaces', () => {
    expect(normalizePhrase('  Opening   HOURS\n')).toBe('opening hours');
  });
});

describe('phraseMatches', () => {
  it('matches exact phrases and whole words inside a message', () => {
    expect(phraseMatches('EXACT', 'menu', 'Menu')).toBe(true);
    expect(phraseMatches('EXACT', 'menu', 'the menu')).toBe(false);
    expect(phraseMatches('CONTAINS', 'hours', 'What are your HOURS?')).toBe(true);
    expect(phraseMatches('CONTAINS', 'opening hours', 'your opening   hours please')).toBe(true);
    expect(phraseMatches('CONTAINS', 'hour', 'hourly rate')).toBe(false);
    expect(phraseMatches('CONTAINS', 'سعر', 'كم سعر الكنبة؟')).toBe(true);
  });
});

describe('pickKeywordTrigger', () => {
  it('prefers an exact keyword over a contains keyword', () => {
    const exact = candidate({ flowId: 'exact', match: 'EXACT', phrase: 'menu' });
    const contains = candidate({ flowId: 'contains', match: 'CONTAINS', phrase: 'menu' });
    expect(pickKeywordTrigger('Menu', [contains, exact])?.flowId).toBe('exact');
  });

  it('prefers the longest contains phrase', () => {
    const short = candidate({ flowId: 'short', phrase: 'price' });
    const long = candidate({ flowId: 'long', phrase: 'sofa price' });
    expect(pickKeywordTrigger('What is the sofa price?', [short, long])?.flowId).toBe('long');
  });

  it('breaks ties by flow priority, then by the older flow', () => {
    const a = candidate({ flowId: 'a', priority: 50, flowCreatedAt: '2026-11-10T00:00:00Z' });
    const b = candidate({ flowId: 'b', priority: 10, flowCreatedAt: '2026-11-12T00:00:00Z' });
    const c = candidate({ flowId: 'c', priority: 10, flowCreatedAt: '2026-11-11T00:00:00Z' });
    expect(pickKeywordTrigger('hours?', [a, b, c])?.flowId).toBe('c');
  });

  it('returns null when nothing matches', () => {
    expect(pickKeywordTrigger('hello', [candidate({})])).toBeNull();
    expect(pickKeywordTrigger(null, [candidate({})])).toBeNull();
  });
});

// 003 T061: patterns that could freeze matching are refused (research R3).
describe('unsafePatternReason', () => {
  it('accepts ordinary patterns', () => {
    for (const pattern of ['order\\s*#?(\\d{4,})', '^(hi|hello)\\b', '[a-z]+@[a-z]+\\.com', '(?:sofa|chair) price', 'a{2,3}(b|c)?']) {
      expect(unsafePatternReason(pattern), pattern).toBeNull();
    }
  });

  it('refuses repeated groups that hold a repeat, back-references, invalid and long patterns', () => {
    for (const pattern of ['(a+)+', '(\\w*)*$', '((ab)+)+', '(x+){2,}', '(?:a+)+b', '([a-z]+\\s?)*']) {
      expect(unsafePatternReason(pattern), pattern).toMatch(/repeat/i);
    }
    expect(unsafePatternReason('(a)\\1')).toMatch(/Back-references/);
    expect(unsafePatternReason('([a-z')).toMatch(/not a valid/);
    expect(unsafePatternReason('a'.repeat(201))).toMatch(/at most/);
    expect(unsafePatternReason('  ')).toBe('Add the pattern');
  });
});
