import { describe, expect, it } from 'vitest';
import { addDays, checkAnswer, parseDateAnswer, toAsciiDigits, type AnswerContext } from './answers.js';

// 003 T028: answer kinds of question steps (contracts/flow-graph.md "Answer kinds").
const ctx: AnswerContext = {
  today: '2026-11-20',
  // Stands in for the API's libphonenumber normaliser (001 contact rules), which the engine passes in.
  normalizePhone: (input) => {
    const compact = input.replace(/[\s().-]/g, '');
    if (/^\+\d{8,15}$/.test(compact)) return compact;
    if (/^0\d{9}$/.test(compact)) return `+971${compact.slice(1)}`;
    return null;
  },
};

describe('text answers', () => {
  it('trims and accepts text within the length limits', () => {
    expect(checkAnswer({ kind: 'text' }, '  Sara Khan ', ctx)).toEqual({ ok: true, value: 'Sara Khan' });
    expect(checkAnswer({ kind: 'text', minLength: 3 }, 'ab', ctx)).toEqual({ ok: false, problem: 'too_short' });
    expect(checkAnswer({ kind: 'text', maxLength: 5 }, 'abcdef', ctx)).toEqual({ ok: false, problem: 'too_long' });
  });

  it('treats an empty answer, or no text at all (a photo), as invalid', () => {
    expect(checkAnswer({ kind: 'text' }, '   ', ctx)).toEqual({ ok: false, problem: 'empty' });
    expect(checkAnswer({ kind: 'text' }, null, ctx)).toEqual({ ok: false, problem: 'empty' });
  });

  it('caps text without a maximum at 1000 characters and counts an emoji as one', () => {
    expect(checkAnswer({ kind: 'text' }, 'x'.repeat(1001), ctx)).toEqual({ ok: false, problem: 'too_long' });
    expect(checkAnswer({ kind: 'text', maxLength: 2 }, '👍👍', ctx)).toEqual({ ok: true, value: '👍👍' });
  });
});

describe('number answers', () => {
  it('reads whole numbers, decimals, thousands separators and Arabic-Indic digits', () => {
    expect(checkAnswer({ kind: 'number' }, '42', ctx)).toEqual({ ok: true, value: 42 });
    expect(checkAnswer({ kind: 'number' }, ' 12.5 ', ctx)).toEqual({ ok: true, value: 12.5 });
    expect(checkAnswer({ kind: 'number' }, '12,5', ctx)).toEqual({ ok: true, value: 12.5 });
    expect(checkAnswer({ kind: 'number' }, '1,250', ctx)).toEqual({ ok: true, value: 1250 });
    expect(checkAnswer({ kind: 'number' }, '-3', ctx)).toEqual({ ok: true, value: -3 });
    expect(checkAnswer({ kind: 'number' }, '٣٥', ctx)).toEqual({ ok: true, value: 35 });
  });

  it('checks whole numbers, minimum and maximum', () => {
    expect(checkAnswer({ kind: 'number', integer: true }, '2.5', ctx)).toEqual({ ok: false, problem: 'not_whole' });
    expect(checkAnswer({ kind: 'number', min: 1 }, '0', ctx)).toEqual({ ok: false, problem: 'too_small' });
    expect(checkAnswer({ kind: 'number', max: 10 }, '11', ctx)).toEqual({ ok: false, problem: 'too_large' });
    expect(checkAnswer({ kind: 'number', min: 1, max: 10, integer: true }, '10', ctx)).toEqual({ ok: true, value: 10 });
  });

  it('refuses words, units and exponents', () => {
    for (const input of ['five', '5 kg', '1e5', '12.5.1', '--3']) {
      expect(checkAnswer({ kind: 'number' }, input, ctx)).toEqual({ ok: false, problem: 'not_a_number' });
    }
  });
});

describe('email answers', () => {
  it('stores a valid email in lower case', () => {
    expect(checkAnswer({ kind: 'email' }, ' Sara.Khan@Example.COM ', ctx)).toEqual({ ok: true, value: 'sara.khan@example.com' });
  });

  it('refuses addresses that are not emails', () => {
    for (const input of ['sara@', 'sara@example', 'sara khan@example.com', 'example.com']) {
      expect(checkAnswer({ kind: 'email' }, input, ctx)).toEqual({ ok: false, problem: 'not_an_email' });
    }
  });
});

describe('phone answers', () => {
  it('normalises to E.164 with the default country, also from Arabic-Indic digits', () => {
    expect(checkAnswer({ kind: 'phone' }, '050 123 4567', ctx)).toEqual({ ok: true, value: '+971501234567' });
    expect(checkAnswer({ kind: 'phone' }, '+92 300 1234567', ctx)).toEqual({ ok: true, value: '+923001234567' });
    expect(checkAnswer({ kind: 'phone' }, '٠٥٠١٢٣٤٥٦٧', ctx)).toEqual({ ok: true, value: '+971501234567' });
  });

  it('refuses numbers that are not valid phones', () => {
    expect(checkAnswer({ kind: 'phone' }, '12', ctx)).toEqual({ ok: false, problem: 'not_a_phone' });
  });
});

describe('date answers', () => {
  it('reads dates written in several ways (numbers are day first)', () => {
    for (const input of ['2026-12-05', '05/12/2026', '5/12/2026', '5-12-2026', '5.12.2026', '5/12/26', '5 Dec 2026', '5 December 2026', '5th December 2026', '5th of December 2026', 'December 5, 2026', 'Dec 5 2026', 'dec 5th, 2026']) {
      expect(parseDateAnswer(input, ctx.today), input).toBe('2026-12-05');
    }
  });

  it('reads today and tomorrow, and a date without a year as its next occurrence', () => {
    expect(parseDateAnswer('Today', ctx.today)).toBe('2026-11-20');
    expect(parseDateAnswer('tomorrow', ctx.today)).toBe('2026-11-21');
    expect(parseDateAnswer('5 Dec', ctx.today)).toBe('2026-12-05');
    expect(parseDateAnswer('20 November', ctx.today)).toBe('2026-11-20');
    expect(parseDateAnswer('3 Jan', ctx.today)).toBe('2027-01-03');
    expect(parseDateAnswer('٢٥/١٢/٢٠٢٦', ctx.today)).toBe('2026-12-25');
  });

  it('refuses text and impossible dates', () => {
    for (const input of ['hello', 'yesterday', '31/02/2026', '32/01/2026', '13/13/2026', '', 'decent 5']) {
      expect(parseDateAnswer(input, ctx.today), input).toBeNull();
    }
  });

  it('checks the earliest and latest dates, including today and tomorrow', () => {
    expect(checkAnswer({ kind: 'date', earliest: 'today' }, '19/11/2026', ctx)).toEqual({ ok: false, problem: 'too_early' });
    expect(checkAnswer({ kind: 'date', earliest: 'today' }, 'today', ctx)).toEqual({ ok: true, value: '2026-11-20' });
    expect(checkAnswer({ kind: 'date', earliest: 'tomorrow' }, 'today', ctx)).toEqual({ ok: false, problem: 'too_early' });
    expect(checkAnswer({ kind: 'date', latest: '2026-12-31' }, '2/1/2027', ctx)).toEqual({ ok: false, problem: 'too_late' });
    expect(checkAnswer({ kind: 'date' }, 'hello', ctx)).toEqual({ ok: false, problem: 'not_a_date' });
  });
});

describe('helpers', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('turns Arabic-Indic and Persian digits into ASCII digits', () => {
    expect(toAsciiDigits('٠١٢٣٤٥٦٧٨٩ ۰۱۲۳۴۵۶۷۸۹')).toBe('0123456789 0123456789');
  });
});
