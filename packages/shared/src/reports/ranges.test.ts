import { describe, expect, it } from 'vitest';
import { dayInZone, reportRangeBounds, reportRangeProblem } from './ranges.js';

// T057 (feature 009 US5, research R14): report ranges.
describe('reportRangeProblem', () => {
  const today = '2026-11-27';

  it('accepts a range of up to 366 days within the last 12 months', () => {
    expect(reportRangeProblem('2026-11-01', '2026-11-30', today)).toBeNull();
    expect(reportRangeProblem('2026-11-27', '2026-11-27', today)).toBeNull();
    expect(reportRangeProblem('2025-11-27', '2026-11-27', today)).toBeNull();
  });

  it('refuses a range ending before it starts, longer than 366 days, older than 12 months, or with a bad date', () => {
    expect(reportRangeProblem('2026-11-10', '2026-11-09', today)).toBe('TO_BEFORE_FROM');
    expect(reportRangeProblem('2025-11-27', '2026-11-28', today)).toBe('TOO_LONG');
    expect(reportRangeProblem('2025-11-26', '2025-12-26', today)).toBe('TOO_OLD');
    expect(reportRangeProblem('2026-02-30', '2026-03-01', today)).toBe('BAD_DATE');
    expect(reportRangeProblem('yesterday', '2026-11-01', today)).toBe('BAD_DATE');
  });
});

describe('day bounds in the company time zone', () => {
  it('starts and ends at local midnight', () => {
    expect(reportRangeBounds('2026-11-01', '2026-11-30', 'Asia/Dubai')).toEqual({ start: new Date('2026-10-31T20:00:00Z'), end: new Date('2026-11-30T20:00:00Z') });
    expect(reportRangeBounds('2026-11-01', '2026-11-01', 'UTC')).toEqual({ start: new Date('2026-11-01T00:00:00Z'), end: new Date('2026-11-02T00:00:00Z') });
  });

  it('follows daylight-saving changes', () => {
    // New York moves to daylight time on 2026-03-08: that day has 23 hours.
    expect(reportRangeBounds('2026-03-08', '2026-03-08', 'America/New_York')).toEqual({ start: new Date('2026-03-08T05:00:00Z'), end: new Date('2026-03-09T04:00:00Z') });
  });

  it('knows the company date', () => {
    expect(dayInZone(new Date('2026-11-27T22:00:00Z'), 'Asia/Dubai')).toBe('2026-11-28');
    expect(dayInZone(new Date('2026-11-27T22:00:00Z'), 'UTC')).toBe('2026-11-27');
  });
});
