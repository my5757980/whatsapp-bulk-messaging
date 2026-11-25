import { describe, expect, it } from 'vitest';
import { cartAfterEvent, cartDueAt, cartExpired, cartStepProblems } from './carts.js';

// T063 (feature 006 US6, research R11): cart reminder steps, due times, stops, recovery and expiry.
describe('abandoned cart rules', () => {
  it('accepts 1 to 3 reminders of 30 minutes to 7 days, each later than the one before', () => {
    expect(cartStepProblems([{ waitMinutes: 60 }])).toEqual([]);
    expect(cartStepProblems([{ waitMinutes: 60 }, { waitMinutes: 1440 }, { waitMinutes: 4320 }])).toEqual([]);
    expect(cartStepProblems([])).toEqual(['Use 1 to 3 reminders']);
    expect(cartStepProblems([{ waitMinutes: 60 }, { waitMinutes: 120 }, { waitMinutes: 180 }, { waitMinutes: 240 }])).toContain('Use 1 to 3 reminders');
    expect(cartStepProblems([{ waitMinutes: 10 }])).toEqual(['Reminder 1: wait between 30 minutes and 7 days']);
    expect(cartStepProblems([{ waitMinutes: 60 }, { waitMinutes: 60 }])).toEqual(['Reminder 2 must come later than reminder 1']);
    expect(cartStepProblems([{ waitMinutes: 60 }, { waitMinutes: 10081 }])).toEqual(['Reminder 2: wait between 30 minutes and 7 days']);
  });

  it('counts each reminder from the start of the cart', () => {
    const started = new Date('2026-11-24T10:00:00Z');
    const steps = [{ waitMinutes: 60 }, { waitMinutes: 1440 }];
    expect(cartDueAt(started, 1, steps)).toEqual(new Date('2026-11-24T11:00:00Z'));
    expect(cartDueAt(started, 2, steps)).toEqual(new Date('2026-11-25T10:00:00Z'));
    expect(cartDueAt(started, 3, steps)).toBeNull();
  });

  it('recovers a cart ordered within 7 days of a reminder; an order before any reminder only closes it', () => {
    const reminded = new Date('2026-11-24T11:00:00Z');
    expect(cartAfterEvent({ lastReminderAt: reminded }, { kind: 'ORDERED', at: new Date('2026-11-25T09:00:00Z') })).toEqual({ status: 'RECOVERED', reason: 'ordered' });
    expect(cartAfterEvent({ lastReminderAt: reminded }, { kind: 'ORDERED', at: new Date('2026-12-02T11:00:01Z') })).toEqual({ status: 'STOPPED', reason: 'ordered' });
    expect(cartAfterEvent({ lastReminderAt: null }, { kind: 'ORDERED', at: new Date('2026-11-24T10:30:00Z') })).toEqual({ status: 'STOPPED', reason: 'ordered' });
    expect(cartAfterEvent({ lastReminderAt: reminded }, { kind: 'OPTED_OUT' })).toEqual({ status: 'STOPPED', reason: 'opted_out' });
    expect(cartAfterEvent({ lastReminderAt: null }, { kind: 'REPLIED' })).toEqual({ status: 'STOPPED', reason: 'replied' });
    expect(cartAfterEvent({ lastReminderAt: null }, { kind: 'BLOCKED' })).toEqual({ status: 'STOPPED', reason: 'blocked' });
  });

  it('expires carts older than 7 days', () => {
    const started = new Date('2026-11-24T10:00:00Z');
    expect(cartExpired(started, new Date('2026-12-01T10:00:00Z'))).toBe(false);
    expect(cartExpired(started, new Date('2026-12-01T10:00:01Z'))).toBe(true);
  });
});
