import { FLOW_LIMITS, type AnswerSpec } from './graph.js';

// Answer checks for question steps (003 T032, contracts/flow-graph.md "Answer kinds"). Pure: the
// caller passes "today" in the company time zone and the phone normaliser 001 contacts use.

export type AnswerProblem =
  | 'empty'
  | 'too_short'
  | 'too_long'
  | 'not_a_number'
  | 'not_whole'
  | 'too_small'
  | 'too_large'
  | 'not_an_email'
  | 'not_a_phone'
  | 'not_a_date'
  | 'too_early'
  | 'too_late';

export type AnswerResult = { ok: true; value: string | number } | { ok: false; problem: AnswerProblem };

export interface AnswerContext {
  /** Today in the company time zone, YYYY-MM-DD. */
  today: string;
  /** E.164 for a valid phone number (001 contact rules with the company's default country), else null. */
  normalizePhone: (input: string) => string | null;
}

const fail = (problem: AnswerProblem): AnswerResult => ({ ok: false, problem });

/** Arabic-Indic (U+0660–0669) and Persian (U+06F0–06F9) digits become ASCII digits. */
export function toAsciiDigits(input: string): string {
  return input.replace(/[٠-٩۰-۹]/g, (digit) => {
    const code = digit.charCodeAt(0);
    return String(code - (code >= 0x06f0 ? 0x06f0 : 0x0660));
  });
}

/** YYYY-MM-DD plus a number of days (negative goes back). */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days)).toISOString().slice(0, 10);
}

function isoIfValid(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** 1–12 for a month name or its start ("dec", "sept"), else null. */
function monthOf(word: string): number | null {
  if (word.length < 3) return null;
  const index = MONTHS.findIndex((name) => name.startsWith(word));
  return index === -1 ? null : index + 1;
}

const fullYear = (value: string): number => (value.length === 2 ? 2000 + Number(value) : Number(value));

/** A day and month without a year: the next time it comes, today included. */
function nextOccurrence(month: number, day: number, today: string): string | null {
  const year = Number(today.slice(0, 4));
  const thisYear = isoIfValid(year, month, day);
  if (thisYear && thisYear >= today) return thisYear;
  return isoIfValid(year + 1, month, day);
}

function dayMonthYear(day: number, month: number | null, year: string | undefined, today: string): string | null {
  if (month === null) return null;
  return year ? isoIfValid(fullYear(year), month, day) : nextOccurrence(month, day, today);
}

/**
 * A date answer as YYYY-MM-DD, or null. Reads ISO dates, day-first numbers (25/12/2026, 25-12-26,
 * 25.12.2026), written months (25 Dec 2026, 25th of December, December 25, 2026), "today" and
 * "tomorrow". A date without a year means its next occurrence.
 */
export function parseDateAnswer(input: string, today: string): string | null {
  const s = toAsciiDigits(input).trim().toLowerCase().replace(/\s+/g, ' ');
  if (!s) return null;
  if (s === 'today') return today;
  if (s === 'tomorrow') return addDays(today, 1);
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return isoIfValid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4}|\d{2})$/.exec(s);
  if (m) return isoIfValid(fullYear(m[3]!), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})(?:st|nd|rd|th)?(?: of)? ([a-z]+)\.?,?(?: (\d{4}))?$/.exec(s);
  if (m) return dayMonthYear(Number(m[1]), monthOf(m[2]!), m[3], today);
  m = /^([a-z]+)\.? (\d{1,2})(?:st|nd|rd|th)?,?(?: (\d{4}))?$/.exec(s);
  if (m) return dayMonthYear(Number(m[2]), monthOf(m[1]!), m[3], today);
  return null;
}

/** "today", "tomorrow" or a YYYY-MM-DD bound as a date. */
export function resolveDateBound(bound: string, today: string): string {
  if (bound === 'today') return today;
  if (bound === 'tomorrow') return addDays(today, 1);
  return bound;
}

/** A number answer: decimals with a dot or a single comma, thousands with commas or spaces. */
function parseNumber(input: string): number | null {
  const s = toAsciiDigits(input).replace(/\s+/g, '');
  let plain = s;
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) plain = s.replace(/,/g, '');
  else if (/^[-+]?\d+,\d+$/.test(s)) plain = s.replace(',', '.');
  if (!/^[-+]?(\d+\.?\d*|\.\d+)$/.test(plain)) return null;
  const value = Number(plain);
  return Number.isFinite(value) ? value : null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Checks a customer's answer against the question's answer kind (FR-009). */
export function checkAnswer(spec: AnswerSpec, input: string | null, ctx: AnswerContext): AnswerResult {
  const raw = input?.trim() ?? '';
  if (!raw) return fail('empty');
  switch (spec.kind) {
    case 'text': {
      const length = [...raw].length;
      if (spec.minLength !== undefined && length < spec.minLength) return fail('too_short');
      if (length > (spec.maxLength ?? FLOW_LIMITS.textMaxLength)) return fail('too_long');
      return { ok: true, value: raw };
    }
    case 'number': {
      const value = parseNumber(raw);
      if (value === null) return fail('not_a_number');
      if (spec.integer && !Number.isInteger(value)) return fail('not_whole');
      if (spec.min !== undefined && value < spec.min) return fail('too_small');
      if (spec.max !== undefined && value > spec.max) return fail('too_large');
      return { ok: true, value };
    }
    case 'email': {
      const value = raw.toLowerCase();
      return value.length <= 254 && EMAIL.test(value) ? { ok: true, value } : fail('not_an_email');
    }
    case 'phone': {
      const value = ctx.normalizePhone(toAsciiDigits(raw));
      return value ? { ok: true, value } : fail('not_a_phone');
    }
    case 'date': {
      const value = parseDateAnswer(raw, ctx.today);
      if (!value) return fail('not_a_date');
      if (spec.earliest && value < resolveDateBound(spec.earliest, ctx.today)) return fail('too_early');
      if (spec.latest && value > resolveDateBound(spec.latest, ctx.today)) return fail('too_late');
      return { ok: true, value };
    }
  }
}
