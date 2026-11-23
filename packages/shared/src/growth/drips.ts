// Drip campaigns (feature 005, FR-019 - FR-028). Pure rules shared by the api and the drip editor.
import { nextSendableAt, type QuietHours } from './quiet-hours.js';

export const MAX_DRIP_STEPS = 10;
export const MIN_STEP_WAIT_MINUTES = 10;
/** 30 days. */
export const MAX_STEP_WAIT_MINUTES = 43_200;
export const MAX_ACTIVE_DRIPS = 20;
export const MAX_ACTIVE_ENROLMENTS = 100_000;
/** At most this many contacts per manual enrolment request. */
export const MAX_MANUAL_ENROLMENT = 100_000;

export type DripLeftReasonCode =
  | 'REPLIED'
  | 'OPTED_OUT'
  | 'BLOCKED'
  | 'DELETED'
  | 'STOP_TAG'
  | 'CLICKED'
  | 'REMOVED'
  | 'INVALID_NUMBER'
  | 'ARCHIVED';

export type EnrolmentStatusCode = 'ACTIVE' | 'FINISHED' | 'LEFT';

/** The first step may go out right away (0); every wait is otherwise 10 minutes to 30 days (FR-020). */
export function stepWaitProblem(position: number, waitMinutes: number): 'WAIT_OUT_OF_RANGE' | null {
  if (!Number.isInteger(waitMinutes)) return 'WAIT_OUT_OF_RANGE';
  if (position === 1 && waitMinutes === 0) return null;
  return waitMinutes >= MIN_STEP_WAIT_MINUTES && waitMinutes <= MAX_STEP_WAIT_MINUTES ? null : 'WAIT_OUT_OF_RANGE';
}

/** When the next step falls due: the wait after the previous send (or after joining), past quiet hours. */
export function nextDueAt(previousAt: Date, waitMinutes: number, quiet: QuietHours | null | undefined, timezone: string): Date {
  return nextSendableAt(quiet, timezone, new Date(previousAt.getTime() + waitMinutes * 60_000));
}

/**
 * The position a contact waits for after the steps were edited (FR-023). `oldOrder` and `newOrder`
 * are step ids by position; the contact received the steps before `currentPosition` in the old
 * order. They go on after the last of those that is still live, so new steps after it reach them,
 * a removed step moves them on, and no step is sent twice. `newOrder.length + 1` means finished.
 */
export function positionAfterEdit(oldOrder: readonly string[], newOrder: readonly string[], currentPosition: number): number {
  let last = -1;
  for (let i = 0; i < currentPosition - 1 && i < oldOrder.length; i += 1) {
    const at = newOrder.indexOf(oldOrder[i] as string);
    if (at > last) last = at;
  }
  return last + 2;
}

export type DripLeavingEvent =
  | { kind: 'OPTED_OUT' }
  | { kind: 'BLOCKED' }
  | { kind: 'DELETED' }
  | { kind: 'REMOVED' }
  | { kind: 'INVALID_NUMBER' }
  /** A message from the contact to a number. */
  | { kind: 'REPLIED'; numberId: string }
  | { kind: 'TAGS_ADDED'; tagIds: readonly string[] }
  /** A click on a tracked link of a drip's step. */
  | { kind: 'CLICKED'; dripId: string };

export interface DripLeavingRules {
  id: string;
  numberId: string;
  leaveOnReply: boolean;
  leaveOnClick: boolean;
  stopTagIds: readonly string[];
}

/** Why an event makes a contact leave the drip, or null when they stay (FR-028). */
export function leavingReason(event: DripLeavingEvent, drip: DripLeavingRules): DripLeftReasonCode | null {
  switch (event.kind) {
    case 'OPTED_OUT':
    case 'BLOCKED':
    case 'DELETED':
    case 'REMOVED':
    case 'INVALID_NUMBER':
      return event.kind;
    case 'REPLIED':
      return drip.leaveOnReply && event.numberId === drip.numberId ? 'REPLIED' : null;
    case 'TAGS_ADDED':
      return event.tagIds.some((tagId) => drip.stopTagIds.includes(tagId)) ? 'STOP_TAG' : null;
    case 'CLICKED':
      return drip.leaveOnClick && event.dripId === drip.id ? 'CLICKED' : null;
  }
}

export type EnrolDecision = 'ENROL' | 'ALREADY_IN' | 'NO_REJOIN';

/** One enrolment at a time, and a new one after finishing or leaving only when the drip allows it (FR-026). */
export function enrolDecision(previous: readonly EnrolmentStatusCode[], allowRejoin: boolean): EnrolDecision {
  if (previous.includes('ACTIVE')) return 'ALREADY_IN';
  if (previous.length > 0 && !allowRejoin) return 'NO_REJOIN';
  return 'ENROL';
}
