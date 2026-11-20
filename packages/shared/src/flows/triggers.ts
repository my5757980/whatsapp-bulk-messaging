import { FLOW_LIMITS } from './graph.js';
// Trigger matching rules shared by the API and the editor (003 FR-019, FR-020, research R2). Pure.

/** Lower case, single spaces, trimmed: how keyword phrases are stored and compared. */
export function normalizePhrase(text: string): string {
  return text.normalize('NFC').toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * EXACT: the whole message is the phrase. CONTAINS: the phrase appears as whole words (so "hour"
 * does not match "hourly"), in any script. Both ignore case and extra spaces.
 */
export function phraseMatches(match: 'EXACT' | 'CONTAINS', phrase: string, message: string): boolean {
  const p = normalizePhrase(phrase);
  const m = normalizePhrase(message);
  if (!p) return false;
  if (match === 'EXACT') return m === p;
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(p)}(?![\\p{L}\\p{N}])`, 'u').test(m);
}

export interface KeywordCandidate {
  flowId: string;
  triggerKey: string;
  match: 'EXACT' | 'CONTAINS';
  phrase: string;
  /** Lower runs first. */
  priority: number;
  flowCreatedAt: string | Date;
  canInterrupt: boolean;
}

/**
 * The keyword trigger that wins for a message (FR-020): exact before contains, then the longest
 * contains phrase, then the flow priority, then the older flow.
 */
export function pickKeywordTrigger<T extends KeywordCandidate>(message: string | null, candidates: readonly T[]): T | null {
  if (!message?.trim()) return null;
  const matching = candidates.filter((c) => phraseMatches(c.match, c.phrase, message));
  if (!matching.length) return null;
  const time = (value: string | Date) => new Date(value).getTime();
  return [...matching].sort(
    (a, b) =>
      (a.match === b.match ? 0 : a.match === 'EXACT' ? -1 : 1) ||
      (a.match === 'CONTAINS' ? normalizePhrase(b.phrase).length - normalizePhrase(a.phrase).length : 0) ||
      a.priority - b.priority ||
      time(a.flowCreatedAt) - time(b.flowCreatedAt),
  )[0]!;
}

/** True when a phrase is one of the reserved consent or "talk to a person" keywords. */
export function isReservedKeyword(phrase: string, reserved: readonly string[]): boolean {
  const p = normalizePhrase(phrase);
  return reserved.some((r) => normalizePhrase(r) === p);
}

/**
 * Whether a group that holds a repeat is itself repeated, like (a+)+ or (?:x*){2,}: such patterns
 * can take exponential time on some messages (research R3).
 */
function hasNestedRepeat(pattern: string): boolean {
  const groups: boolean[] = [];
  let inClass = false;
  /** Whether the group that just closed holds a repeat (null when the last token was not a group). */
  let closedWithRepeat: boolean | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '\\') {
      i++;
      closedWithRepeat = null;
      continue;
    }
    if (inClass) {
      if (c === ']') inClass = false;
      continue;
    }
    if (c === '[') {
      inClass = true;
      closedWithRepeat = null;
      continue;
    }
    if (c === '(') {
      groups.push(false);
      closedWithRepeat = null;
      if (pattern[i + 1] === '?') i++;
      continue;
    }
    if (c === ')') {
      closedWithRepeat = groups.pop() ?? false;
      continue;
    }
    const repeat = c === '*' || c === '+' || c === '?' || (c === '{' && /^\{\d+(,\d*)?\}/.test(pattern.slice(i)));
    if (repeat) {
      if (closedWithRepeat) return true;
      if (groups.length) groups[groups.length - 1] = true;
    }
    closedWithRepeat = null;
  }
  return false;
}

/** Why a pattern cannot start a flow, or null when it is safe to use (FR-019, research R3). */
export function unsafePatternReason(pattern: string): string | null {
  if (!pattern.trim()) return 'Add the pattern';
  if (pattern.length > FLOW_LIMITS.patternLength) return `Use at most ${FLOW_LIMITS.patternLength} characters`;
  try {
    new RegExp(pattern, 'iu');
  } catch {
    return 'This is not a valid pattern';
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'Back-references are not allowed in patterns';
  if (hasNestedRepeat(pattern)) return 'A repeated group that holds a repeat, like (a+)+, can freeze matching; simplify the pattern';
  return null;
}
