// Usage maths for AI replies and assistant requests (research R8, R10).

/** USD per million tokens, as stored in settings.ai_prices. */
export interface AiPrices {
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const DEFAULT_AI_PRICES: AiPrices = { model: 'claude-opus-5-5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

export interface TokenUsage {
  inputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
}

/** Cost in micro-dollars: tokens × (USD per million tokens) equals micro-dollars exactly. */
export function costMicros(usage: TokenUsage, prices: AiPrices): number {
  return Math.round(
    usage.inputTokens * prices.input +
      usage.cacheReadTokens * prices.cacheRead +
      usage.cacheWriteTokens * prices.cacheWrite +
      usage.outputTokens * prices.output,
  );
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

export const NO_USAGE: TokenUsage = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };

/** 0, 80 or 100: the alert level a count has reached against a monthly limit (FR-038). */
export function alertLevelFor(count: number, limit: number): 0 | 80 | 100 {
  if (limit <= 0 || count >= limit) return 100;
  if (count >= Math.ceil(limit * 0.8)) return 80;
  return 0;
}

function partsIn(date: Date, timeZone: string): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { year: get('year'), month: get('month'), day: get('day') };
}

/** The first day of the month containing `date` in the time zone, as YYYY-MM-01. */
export function monthKey(date: Date, timeZone: string): string {
  const { year, month } = partsIn(date, timeZone);
  return `${year}-${month}-01`;
}

/** The calendar day of `date` in the time zone, as YYYY-MM-DD. */
export function dayKey(date: Date, timeZone: string): string {
  const { year, month, day } = partsIn(date, timeZone);
  return `${year}-${month}-${day}`;
}
