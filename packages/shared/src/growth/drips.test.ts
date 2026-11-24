import { describe, expect, it } from 'vitest';
import { enrolDecision, leavingReason, nextDueAt, positionAfterEdit, stepWaitProblem } from './drips.js';

// T010 (feature 005, FR-019 - FR-028): drip step limits, due times, edits and leaving rules.
describe('stepWaitProblem', () => {
  it('allows a zero wait only at the first step, and 10 minutes to 30 days otherwise', () => {
    expect(stepWaitProblem(1, 0)).toBeNull();
    expect(stepWaitProblem(1, 10)).toBeNull();
    expect(stepWaitProblem(2, 43_200)).toBeNull();
    expect(stepWaitProblem(2, 0)).toBe('WAIT_OUT_OF_RANGE');
    expect(stepWaitProblem(1, 5)).toBe('WAIT_OUT_OF_RANGE');
    expect(stepWaitProblem(3, 43_201)).toBe('WAIT_OUT_OF_RANGE');
    expect(stepWaitProblem(2, 12.5)).toBe('WAIT_OUT_OF_RANGE');
  });
});

describe('nextDueAt', () => {
  const night = { from: '21:00', to: '09:00', days: [1, 2, 3, 4, 5, 6, 7] };

  it('is the previous send plus the wait', () => {
    expect(nextDueAt(new Date('2026-11-23T06:00:00Z'), 60, null, 'Asia/Dubai').toISOString()).toBe('2026-11-23T07:00:00.000Z');
    expect(nextDueAt(new Date('2026-11-23T06:00:00Z'), 0, night, 'Asia/Dubai').toISOString()).toBe('2026-11-23T06:00:00.000Z');
  });

  it('moves past quiet hours', () => {
    // Sent 20:30 Dubai, wait 60 minutes -> 21:30 is quiet -> 09:00 next morning.
    expect(nextDueAt(new Date('2026-11-23T16:30:00Z'), 60, night, 'Asia/Dubai').toISOString()).toBe('2026-11-24T05:00:00.000Z');
  });
});

describe('positionAfterEdit', () => {
  it('keeps a contact on the step they were waiting for when nothing changed before it', () => {
    expect(positionAfterEdit(['a', 'b', 'c'], ['a', 'b', 'c'], 2)).toBe(2);
    expect(positionAfterEdit(['a', 'b', 'c'], ['a', 'b', 'c', 'd'], 4)).toBe(4);
  });

  it('moves a contact waiting for a removed step on to the next live step', () => {
    expect(positionAfterEdit(['a', 'b', 'c'], ['a', 'c'], 2)).toBe(2); // was waiting for b -> c
    expect(positionAfterEdit(['a', 'b', 'c'], ['a', 'c'], 3)).toBe(2); // was waiting for c -> still c
    expect(positionAfterEdit(['a', 'b', 'c'], ['a', 'b'], 3)).toBe(3); // was waiting for c -> finished
  });

  it('gives new steps after the last step received, and never a step twice', () => {
    expect(positionAfterEdit(['a', 'b', 'c'], ['a', 'x', 'b', 'c'], 2)).toBe(2); // received a -> x next
    expect(positionAfterEdit(['a', 'b', 'c'], ['b', 'a', 'c'], 3)).toBe(3); // received a and b -> c next
    expect(positionAfterEdit(['a', 'b'], ['x', 'b'], 2)).toBe(1); // the only step received was removed
    expect(positionAfterEdit(['a', 'b'], ['x', 'a', 'b'], 1)).toBe(1); // nothing received yet
  });
});

describe('leavingReason', () => {
  const drip = { id: 'drip-1', numberId: 'num-1', leaveOnReply: true, leaveOnClick: false, stopTagIds: ['tag-stop'] };

  it('always leaves on opt-out, block, deletion, removal and an invalid number', () => {
    expect(leavingReason({ kind: 'OPTED_OUT' }, drip)).toBe('OPTED_OUT');
    expect(leavingReason({ kind: 'BLOCKED' }, drip)).toBe('BLOCKED');
    expect(leavingReason({ kind: 'DELETED' }, drip)).toBe('DELETED');
    expect(leavingReason({ kind: 'REMOVED' }, drip)).toBe('REMOVED');
    expect(leavingReason({ kind: 'INVALID_NUMBER' }, drip)).toBe('INVALID_NUMBER');
  });

  it("leaves on a message to the drip's own number when that rule is on", () => {
    expect(leavingReason({ kind: 'REPLIED', numberId: 'num-1' }, drip)).toBe('REPLIED');
    expect(leavingReason({ kind: 'REPLIED', numberId: 'num-2' }, drip)).toBeNull();
    expect(leavingReason({ kind: 'REPLIED', numberId: 'num-1' }, { ...drip, leaveOnReply: false })).toBeNull();
  });

  it("leaves on one of the drip's stop tags, and on a click on its own links when that rule is on", () => {
    expect(leavingReason({ kind: 'TAGS_ADDED', tagIds: ['tag-x', 'tag-stop'] }, drip)).toBe('STOP_TAG');
    expect(leavingReason({ kind: 'TAGS_ADDED', tagIds: ['tag-x'] }, drip)).toBeNull();
    expect(leavingReason({ kind: 'CLICKED', dripId: 'drip-1' }, drip)).toBeNull();
    expect(leavingReason({ kind: 'CLICKED', dripId: 'drip-1' }, { ...drip, leaveOnClick: true })).toBe('CLICKED');
    expect(leavingReason({ kind: 'CLICKED', dripId: 'drip-2' }, { ...drip, leaveOnClick: true })).toBeNull();
  });
});

describe('enrolDecision', () => {
  it('enrols a contact once at a time, and again only when the drip allows joining again', () => {
    expect(enrolDecision([], false)).toBe('ENROL');
    expect(enrolDecision(['ACTIVE'], true)).toBe('ALREADY_IN');
    expect(enrolDecision(['FINISHED'], false)).toBe('NO_REJOIN');
    expect(enrolDecision(['LEFT', 'FINISHED'], true)).toBe('ENROL');
  });
});
