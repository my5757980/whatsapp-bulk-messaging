import { describe, expect, it } from 'vitest';
import { alertLevelFor, costMicros, dayKey, monthKey } from './usage.js';

// T014: usage maths (research R8, R10).
describe('costMicros', () => {
  const prices = { model: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

  it('prices every token kind in USD per million tokens, as whole micro-dollars', () => {
    // 1,000 input × $4/M = $0.004; 30,000 cache reads × $0.20/M = $0.006; 2,000 writes × $5/M = $0.01; 500 out × $20/M = $0.01
    expect(costMicros({ inputTokens: 1000, cacheReadTokens: 30000, cacheWriteTokens: 2000, outputTokens: 500 }, prices)).toBe(30000);
    expect(costMicros({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }, prices)).toBe(0);
  });
});

describe('alertLevelFor', () => {
  it('is 80 from 80% of the limit and 100 at the limit', () => {
    expect(alertLevelFor(3, 5)).toBe(0);
    expect(alertLevelFor(4, 5)).toBe(80);
    expect(alertLevelFor(5, 5)).toBe(100);
    expect(alertLevelFor(799, 1000)).toBe(0);
    expect(alertLevelFor(800, 1000)).toBe(80);
    expect(alertLevelFor(1000, 1000)).toBe(100);
    expect(alertLevelFor(1, 0)).toBe(100);
  });
});

describe('monthKey and dayKey', () => {
  it('use the company time zone', () => {
    // 2026-11-30 21:30 UTC is already 1 December in Dubai (UTC+4).
    const lateNovemberUtc = new Date('2026-11-30T21:30:00Z');
    expect(monthKey(lateNovemberUtc, 'Asia/Dubai')).toBe('2026-12-01');
    expect(monthKey(lateNovemberUtc, 'UTC')).toBe('2026-11-01');
    expect(dayKey(lateNovemberUtc, 'Asia/Dubai')).toBe('2026-12-01');
    expect(dayKey(lateNovemberUtc, 'UTC')).toBe('2026-11-30');
  });
});
