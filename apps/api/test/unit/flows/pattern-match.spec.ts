import { describe, expect, it } from 'vitest';
import { matchPattern, PATTERN_TIMEOUT_MS } from '../../../src/modules/flows/engine/pattern-match.js';

// 003 T061: pattern triggers match without case, store the first group (or the whole match), and a
// catastrophic pattern gives "no match" within the time limit instead of stalling the worker.
describe('matchPattern', () => {
  it('returns the first capture group, or the whole match without groups', () => {
    expect(matchPattern('order\\s*#?(\\d{4,})', 'Where is ORDER #12345 now?')).toEqual({ matched: true, value: '12345' });
    expect(matchPattern('sofa|chair', 'Do you have a Sofa?')).toEqual({ matched: true, value: 'Sofa' });
    expect(matchPattern('^refund$', 'refund please')).toEqual({ matched: false, timedOut: false });
  });

  it('treats a broken pattern as no match', () => {
    expect(matchPattern('([a-z', 'abc')).toMatchObject({ matched: false });
  });

  it('gives up on a catastrophic pattern within the time limit', () => {
    const started = Date.now();
    const result = matchPattern('(a+)+$', `${'a'.repeat(40)}!`);
    expect(Date.now() - started).toBeLessThan(PATTERN_TIMEOUT_MS + 1_000);
    expect(result.matched).toBe(false);
  });
});
