import { describe, expect, it } from 'vitest';
import { nextReminder, reminderRulesProblem } from './reminders.js';

// T010 (feature 008, research R6): up to two reminders before expiry, each at most once.
const MIN = 60_000;
const HOUR = 60 * MIN;
const CREATED = Date.UTC(2026, 10, 25, 9, 0, 0);
const EXPIRES = CREATED + 24 * HOUR;

describe('nextReminder', () => {
  const rules = [{ beforeMinutes: 60 }, { beforeMinutes: 6 * 60 }];

  it('orders reminders by time (the one furthest before expiry first)', () => {
    expect(nextReminder({ createdAt: CREATED, expiresAt: EXPIRES, rules, processed: 0 })).toEqual({ slot: 0, at: EXPIRES - 6 * HOUR });
    expect(nextReminder({ createdAt: CREATED, expiresAt: EXPIRES, rules, processed: 1 })).toEqual({ slot: 1, at: EXPIRES - HOUR });
    expect(nextReminder({ createdAt: CREATED, expiresAt: EXPIRES, rules, processed: 2 })).toBeNull();
  });

  it('skips a reminder that would fall before (or right at) creation', () => {
    const shortExpiry = CREATED + 2 * HOUR;
    expect(nextReminder({ createdAt: CREATED, expiresAt: shortExpiry, rules, processed: 0 })).toEqual({ slot: 1, at: shortExpiry - HOUR });
    expect(nextReminder({ createdAt: CREATED, expiresAt: CREATED + 30 * MIN, rules, processed: 0 })).toBeNull();
  });

  it('has nothing to send without rules', () => {
    expect(nextReminder({ createdAt: CREATED, expiresAt: EXPIRES, rules: [], processed: 0 })).toBeNull();
  });
});

describe('reminderRulesProblem', () => {
  it('allows up to two distinct reminders between 15 minutes and 30 days minus 30 minutes', () => {
    expect(reminderRulesProblem([])).toBeNull();
    expect(reminderRulesProblem([{ beforeMinutes: 360 }, { beforeMinutes: 60 }])).toBeNull();
    expect(reminderRulesProblem([{ beforeMinutes: 60 }, { beforeMinutes: 120 }, { beforeMinutes: 180 }])).toMatch(/two/);
    expect(reminderRulesProblem([{ beforeMinutes: 14 }])).toMatch(/15/);
    expect(reminderRulesProblem([{ beforeMinutes: 43_171 }])).not.toBeNull();
    expect(reminderRulesProblem([{ beforeMinutes: 60 }, { beforeMinutes: 60 }])).toMatch(/different/);
    expect(reminderRulesProblem([{ beforeMinutes: 60.5 }])).not.toBeNull();
  });
});
