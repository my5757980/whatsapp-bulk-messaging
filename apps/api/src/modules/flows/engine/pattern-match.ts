import { createContext, Script } from 'node:vm';

// Pattern triggers (003 T064, research R3): a manager's pattern runs in its own V8 context with a
// short time limit, so even a pattern that slipped past the safety check cannot stall message
// handling. The limit is wall-clock time, which a busy worker can stretch, so a timeout gets one
// retry with twice the limit before it counts as "no match" (like a broken pattern).

export const PATTERN_TIMEOUT_MS = 50;

export type PatternResult = { matched: true; value: string } | { matched: false; timedOut: boolean };

/** Compiled once; each call sets `pattern` and `text` on the shared context and runs it. */
const SCRIPT = new Script('(() => { const m = new RegExp(pattern, "iu").exec(text); return m ? [m[0], m[1] === undefined ? null : m[1]] : null; })()');
const context = createContext({ pattern: '', text: '' }) as { pattern: string; text: string };

const isTimeout = (error: unknown) => /timed out/i.test((error as Error).message);

/** The first capture group (or the whole match) when the pattern matches, cut to 1000 characters. */
export function matchPattern(pattern: string, text: string, timeoutMs: number = PATTERN_TIMEOUT_MS): PatternResult {
  context.pattern = pattern;
  context.text = text;
  let found: [string, string | null] | null;
  try {
    found = SCRIPT.runInContext(context, { timeout: timeoutMs }) as [string, string | null] | null;
  } catch (error) {
    if (!isTimeout(error)) return { matched: false, timedOut: false };
    try {
      found = SCRIPT.runInContext(context, { timeout: timeoutMs * 2 }) as [string, string | null] | null;
    } catch (retryError) {
      return { matched: false, timedOut: isTimeout(retryError) };
    }
  }
  if (!found) return { matched: false, timedOut: false };
  return { matched: true, value: (found[1] ?? found[0]).slice(0, 1000) };
}
