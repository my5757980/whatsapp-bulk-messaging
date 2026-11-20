import { runInNewContext } from 'node:vm';

// Pattern triggers (003 T064, research R3): a manager's pattern runs in its own V8 context with a
// short time limit, so even a pattern that slipped past the safety check cannot stall message
// handling. A timeout, like a broken pattern, counts as "no match".

export const PATTERN_TIMEOUT_MS = 25;

export type PatternResult = { matched: true; value: string } | { matched: false; timedOut: boolean };

const SCRIPT = '(() => { const m = new RegExp(pattern, "iu").exec(text); return m ? [m[0], m[1] === undefined ? null : m[1]] : null; })()';

/** The first capture group (or the whole match) when the pattern matches, cut to 1000 characters. */
export function matchPattern(pattern: string, text: string, timeoutMs: number = PATTERN_TIMEOUT_MS): PatternResult {
  try {
    const found = runInNewContext(SCRIPT, { pattern, text }, { timeout: timeoutMs }) as [string, string | null] | null;
    if (!found) return { matched: false, timedOut: false };
    return { matched: true, value: (found[1] ?? found[0]).slice(0, 1000) };
  } catch (error) {
    return { matched: false, timedOut: /timed out/i.test((error as Error).message) };
  }
}
