// Feature 006 (T005): a request catcher for e2e checks of outbound webhooks.
// POST /catch/:name records the method, headers and raw body and answers 200, or the status given
// in ?status= (to test retries). GET /catch/:name lists what arrived; DELETE /catch/:name clears it.

export interface CaughtRequest {
  method: string;
  headers: Record<string, string>;
  body: string;
  receivedAt: string;
}

const caught = new Map<string, CaughtRequest[]>();
/** Per-name answer set with POST /catch/:name/answer, so a test can make an endpoint fail and recover. */
const answers = new Map<string, number>();

const MAX_PER_NAME = 1000;

export function catchName(pathname: string): { name: string; action: 'record' | 'answer' } | null {
  const match = /^\/catch\/([A-Za-z0-9_-]{1,60})(\/answer)?$/.exec(pathname);
  if (!match) return null;
  return { name: match[1]!, action: match[2] ? 'answer' : 'record' };
}

export function record(name: string, method: string, headers: Record<string, string | string[] | undefined>, body: string): CaughtRequest {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) if (value !== undefined) flat[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value;
  const entry: CaughtRequest = { method, headers: flat, body, receivedAt: new Date().toISOString() };
  const list = caught.get(name) ?? [];
  list.push(entry);
  if (list.length > MAX_PER_NAME) list.shift();
  caught.set(name, list);
  return entry;
}

export function list(name: string): CaughtRequest[] {
  return caught.get(name) ?? [];
}

export function clear(name: string): void {
  caught.delete(name);
  answers.delete(name);
}

export function setAnswer(name: string, status: number): void {
  answers.set(name, status);
}

/** The status to answer: ?status= wins, then the name's set answer, then 200. */
export function answerFor(name: string, queryStatus: string | null): number {
  const fromQuery = queryStatus ? Number(queryStatus) : NaN;
  if (Number.isInteger(fromQuery) && fromQuery >= 100 && fromQuery <= 599) return fromQuery;
  return answers.get(name) ?? 200;
}
