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
