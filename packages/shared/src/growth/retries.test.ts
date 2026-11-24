import { describe, expect, it } from 'vitest';
import { RETRY_DELAY_CHOICES, retryPlanProblem, retryRoundDueAt, retryWindowEndsAt, isWithinRetryWindow } from './retries.js';

// T008 (feature 005, FR-013, research R5): retry plans and round times.
describe('retryPlanProblem', () => {
  it('accepts 0 to 3 rounds with one allowed delay each, adding up to at most 24 hours', () => {
    expect(RETRY_DELAY_CHOICES).toEqual([30, 60, 120, 240, 480, 720]);
    expect(retryPlanProblem({ rounds: 0, delaysMinutes: [] })).toBeNull();
    expect(retryPlanProblem({ rounds: 1, delaysMinutes: [30] })).toBeNull();
    expect(retryPlanProblem({ rounds: 3, delaysMinutes: [720, 480, 240] })).toBeNull();
  });

  it('refuses other round counts, delays that do not match the rounds, and delays outside the list', () => {
    expect(retryPlanProblem({ rounds: 4, delaysMinutes: [30, 30, 30, 30] })).toBe('ROUNDS_OUT_OF_RANGE');
    expect(retryPlanProblem({ rounds: -1, delaysMinutes: [] })).toBe('ROUNDS_OUT_OF_RANGE');
    expect(retryPlanProblem({ rounds: 1.5, delaysMinutes: [30] })).toBe('ROUNDS_OUT_OF_RANGE');
    expect(retryPlanProblem({ rounds: 2, delaysMinutes: [30] })).toBe('DELAYS_DO_NOT_MATCH_ROUNDS');
    expect(retryPlanProblem({ rounds: 0, delaysMinutes: [30] })).toBe('DELAYS_DO_NOT_MATCH_ROUNDS');
    expect(retryPlanProblem({ rounds: 1, delaysMinutes: [45] })).toBe('DELAY_NOT_ALLOWED');
  });

  it('refuses plans whose delays add up to more than 24 hours', () => {
    expect(retryPlanProblem({ rounds: 3, delaysMinutes: [720, 720, 30] })).toBe('RETRY_WINDOW_EXCEEDED');
    expect(retryPlanProblem({ rounds: 2, delaysMinutes: [720, 720] })).toBeNull();
  });
});

describe('round times', () => {
  const launchedAt = new Date('2026-11-23T08:00:00.000Z');

  it('falls due the chosen delay after the previous attempt finished', () => {
    expect(retryRoundDueAt(new Date('2026-11-23T08:20:00.000Z'), 60).toISOString()).toBe('2026-11-23T09:20:00.000Z');
  });

  it('allows rounds to start until 24 hours after the campaign started, and not after', () => {
    expect(retryWindowEndsAt(launchedAt).toISOString()).toBe('2026-11-24T08:00:00.000Z');
    expect(isWithinRetryWindow(launchedAt, new Date('2026-11-24T08:00:00.000Z'))).toBe(true);
    expect(isWithinRetryWindow(launchedAt, new Date('2026-11-24T08:01:00.000Z'))).toBe(false);
  });
});
