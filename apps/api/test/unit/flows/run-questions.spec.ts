import { FlowGraphSchema, type FlowGraph } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import type { FlowEffect } from '../../../src/modules/flows/engine/effects.js';
import { newSessionState, replyIdFor, run, type RunContext, type SessionState } from '../../../src/modules/flows/engine/run.js';

// 003 T029: question and list steps - retries, then the invalid branch; media instead of text;
// answers and attribute effects; list choices (own branch or shared next); timeouts; fallbacks.
const SESSION = '22222222-2222-7222-8222-222222222222';

const booking = (question: Record<string, unknown> = {}): FlowGraph =>
  FlowGraphSchema.parse({
    version: 1,
    start: 'date',
    steps: [
      {
        id: 'date',
        type: 'question',
        text: 'Which day suits you, {first_name}?',
        answer: { kind: 'date', earliest: 'today' },
        answerName: 'visit_date',
        saveTo: { attributeKey: 'visit_date' },
        retries: 2,
        retryText: 'Please send a date from today on, like 25/12.',
        timeoutMinutes: 30,
        next: 'branch',
        onInvalid: 'person',
        onTimeout: 'later',
        fallbacks: { first_name: 'there' },
        ...question,
      },
      {
        id: 'branch',
        type: 'list',
        text: 'Which branch?',
        buttonLabel: 'Branches',
        sections: [
          {
            title: 'UAE',
            rows: [
              { key: 'dxb', title: 'Dubai', next: 'thanks' },
              { key: 'shj', title: 'Sharjah', description: 'Al Majaz', next: 'thanks' },
            ],
          },
        ],
        answerName: 'branch',
        saveTo: { attributeKey: 'branch' },
        timeoutMinutes: 30,
      },
      { id: 'thanks', type: 'message', text: 'See you on {answer:visit_date} at {answer:branch}.', next: null },
      { id: 'person', type: 'message', text: 'A person will help you.', next: null },
      { id: 'later', type: 'message', text: 'No problem, write visit any time.', next: null },
    ],
  });

/** A list that sends every option to one step. */
const sharedList = (onInvalid: string | null = null): FlowGraph =>
  FlowGraphSchema.parse({
    version: 1,
    start: 'branch',
    steps: [
      {
        id: 'branch',
        type: 'list',
        text: 'Which branch?',
        buttonLabel: 'Branches',
        sections: [{ rows: [{ key: 'dxb', title: 'Dubai' }, { key: 'shj', title: 'Sharjah' }] }],
        sharedNext: 'thanks',
        answerName: 'branch',
        onInvalid,
      },
      { id: 'thanks', type: 'message', text: 'Noted: {answer:branch}.', next: null },
      { id: 'again', type: 'message', text: 'Please pick from the list.', next: null },
    ],
  });

const render: RunContext['render'] = (text, fallbacks, answers) =>
  text
    .replace(/\{first_name\}/g, fallbacks.first_name ?? '')
    .replace(/\{answer:([a-z0-9_]+)\}/g, (_match, name: string) => String(answers[name] ?? fallbacks[`answer:${name}`] ?? ''));
const ctx = (g: FlowGraph): RunContext => ({
  graph: g,
  render,
  answers: { today: '2026-11-20', normalizePhone: (input) => (/^\+\d{8,15}$/.test(input) ? input : null) },
});
const text = (value: string) => ({ kind: 'message' as const, text: value, replyId: null, contentType: 'TEXT' });
const tap = (replyId: string, title: string) => ({ kind: 'message' as const, text: title, replyId, contentType: 'LIST_REPLY' });
const sendsOf = (effects: FlowEffect[]) => effects.flatMap((e) => (e.kind === 'send' ? [e.message] : []));
const start = (g: FlowGraph = booking()) => run(newSessionState(SESSION), { kind: 'start' }, ctx(g));

describe('question steps', () => {
  it('asks the question with fallbacks, waits for the answer and schedules the timeout', () => {
    const result = start();
    expect(result.state).toMatchObject({ currentStepId: 'date', wait: 'INPUT', waitToken: 2, retries: 0 });
    expect(sendsOf(result.effects)).toEqual([{ type: 'text', text: 'Which day suits you, there?' }]);
    expect(result.effects).toContainEqual({ kind: 'schedule', stepId: 'date', purpose: 'timeout', delayMs: 30 * 60_000 });
  });

  it('stores a valid answer, saves the attribute and moves to the list', () => {
    const result = run(start().state, text('25/12/2026'), ctx(booking()));
    expect(result.consumed).toBe(true);
    expect(result.state.answers).toEqual({ visit_date: '2026-12-25' });
    expect(result.effects).toContainEqual({ kind: 'setAttributes', stepId: 'date', values: { visit_date: '2026-12-25' } });
    expect(result.effects).toContainEqual({ kind: 'stepLeft', stepId: 'date', branch: 'next' });
    expect(result.state).toMatchObject({ currentStepId: 'branch', wait: 'INPUT' });
    expect(sendsOf(result.effects)).toEqual([
      {
        type: 'list',
        text: 'Which branch?',
        buttonLabel: 'Branches',
        sections: [
          {
            title: 'UAE',
            rows: [
              { id: replyIdFor(result.state, 'dxb'), title: 'Dubai' },
              { id: replyIdFor(result.state, 'shj'), title: 'Sharjah', description: 'Al Majaz' },
            ],
          },
        ],
      },
    ]);
  });

  it('sends the retry prompt for wrong answers, then follows the invalid branch', () => {
    const first = start().state;
    const retry1 = run(first, text('yesterday'), ctx(booking()));
    expect(retry1.consumed).toBe(true);
    expect(sendsOf(retry1.effects)).toEqual([{ type: 'text', text: 'Please send a date from today on, like 25/12.' }]);
    expect(retry1.state).toMatchObject({ currentStepId: 'date', wait: 'INPUT', retries: 1, waitToken: first.waitToken + 1 });
    expect(retry1.effects).toContainEqual({ kind: 'schedule', stepId: 'date', purpose: 'timeout', delayMs: 30 * 60_000 });
    expect(retry1.effects.some((e) => e.kind === 'setAttributes')).toBe(false);

    const retry2 = run(retry1.state, text('hello'), ctx(booking()));
    expect(retry2.state.retries).toBe(2);
    expect(sendsOf(retry2.effects)).toHaveLength(1);

    const gaveUp = run(retry2.state, text('19/11/2026'), ctx(booking()));
    expect(gaveUp.effects).toContainEqual({ kind: 'stepLeft', stepId: 'date', branch: 'onInvalid' });
    expect(sendsOf(gaveUp.effects)).toEqual([{ type: 'text', text: 'A person will help you.' }]);
    expect(gaveUp.ended).toBe(true);
    expect(gaveUp.state.answers).toEqual({});
  });

  it('ends FAILED after the retries when no invalid branch is connected', () => {
    const g = booking({ retries: 0, onInvalid: null });
    const result = run(start(g).state, text('hello'), ctx(g));
    expect(result.ended).toBe(true);
    expect(result.effects).toContainEqual({ kind: 'end', result: 'FAILED', reason: 'no valid answer' });
    expect(sendsOf(result.effects)).toEqual([]);
  });

  it('counts a photo as a wrong answer when text is expected', () => {
    const g = booking({ answer: { kind: 'text' } });
    const result = run(start(g).state, { kind: 'message', text: 'my caption', replyId: null, contentType: 'IMAGE' }, ctx(g));
    expect(result.state).toMatchObject({ currentStepId: 'date', retries: 1 });
    expect(result.state.answers).toEqual({});
    expect(sendsOf(result.effects)).toEqual([{ type: 'text', text: 'Please send a date from today on, like 25/12.' }]);
  });

  it('asks the question again when the draft has no retry text yet', () => {
    const g = booking({ retryText: '' });
    const result = run(start(g).state, text('hello'), ctx(g));
    expect(sendsOf(result.effects)).toEqual([{ type: 'text', text: 'Which day suits you, there?' }]);
  });

  it('stores numbers as numbers', () => {
    const g = booking({ answer: { kind: 'number', min: 1, max: 10 }, answerName: 'guests', saveTo: { attributeKey: 'guests' } });
    const result = run(start(g).state, text('4'), ctx(g));
    expect(result.state.answers).toEqual({ guests: 4 });
    expect(result.effects).toContainEqual({ kind: 'setAttributes', stepId: 'date', values: { guests: 4 } });
  });

  it('follows the timeout branch, or ends TIMED_OUT without one; an older timer does nothing', () => {
    const waiting = start().state;
    const late = run(waiting, { kind: 'timer', token: waiting.waitToken }, ctx(booking()));
    expect(late.effects).toContainEqual({ kind: 'stepLeft', stepId: 'date', branch: 'onTimeout' });
    expect(sendsOf(late.effects)).toEqual([{ type: 'text', text: 'No problem, write visit any time.' }]);

    const g = booking({ onTimeout: null });
    const quiet = run(start(g).state, { kind: 'timer', token: start(g).state.waitToken }, ctx(g));
    expect(quiet.effects).toContainEqual({ kind: 'end', result: 'TIMED_OUT' });
    expect(sendsOf(quiet.effects)).toEqual([]);

    const afterRetry = run(waiting, text('hello'), ctx(booking())).state;
    const stale = run(afterRetry, { kind: 'timer', token: waiting.waitToken }, ctx(booking()));
    expect(stale.effects).toEqual([]);
    expect(stale.state).toEqual(afterRetry);
  });
});

describe('list steps', () => {
  function atList(): SessionState {
    return run(start().state, text('25/12/2026'), ctx(booking())).state;
  }

  it('takes the tapped row, saves its title and follows its branch', () => {
    const waiting = atList();
    const result = run(waiting, tap(replyIdFor(waiting, 'shj'), 'Sharjah'), ctx(booking()));
    expect(result.state.answers).toEqual({ visit_date: '2026-12-25', branch: 'Sharjah' });
    expect(result.effects).toContainEqual({ kind: 'setAttributes', stepId: 'branch', values: { branch: 'Sharjah' } });
    expect(result.effects).toContainEqual({ kind: 'stepLeft', stepId: 'branch', branch: 'shj' });
    expect(sendsOf(result.effects)).toEqual([{ type: 'text', text: 'See you on 2026-12-25 at Sharjah.' }]);
    expect(result.ended).toBe(true);
  });

  it('continues every row at the shared step, and accepts a typed title', () => {
    const waiting = start(sharedList()).state;
    const result = run(waiting, text('dubai'), ctx(sharedList()));
    expect(result.effects).toContainEqual({ kind: 'stepLeft', stepId: 'branch', branch: 'dxb' });
    expect(sendsOf(result.effects)).toEqual([{ type: 'text', text: 'Noted: Dubai.' }]);
  });

  it('ignores a tap on an older list', () => {
    const waiting = atList();
    const result = run(waiting, tap(`s:${SESSION}:1:dxb`, 'Dubai'), ctx(booking()));
    expect(result).toMatchObject({ consumed: false, ended: false, effects: [] });
    expect(result.state).toEqual(waiting);
  });

  it('follows the invalid branch for other answers, or ends FAILED without one', () => {
    const withBranch = sharedList('again');
    const invalid = run(start(withBranch).state, text('Abu Dhabi'), ctx(withBranch));
    expect(invalid.effects).toContainEqual({ kind: 'stepLeft', stepId: 'branch', branch: 'onInvalid' });
    expect(sendsOf(invalid.effects)).toEqual([{ type: 'text', text: 'Please pick from the list.' }]);

    const failed = run(start(sharedList()).state, text('Abu Dhabi'), ctx(sharedList()));
    expect(failed.effects).toContainEqual({ kind: 'end', result: 'FAILED', reason: 'no valid answer' });
  });

  it('times out like a question', () => {
    const waiting = start(sharedList()).state;
    const result = run(waiting, { kind: 'timer', token: waiting.waitToken }, ctx(sharedList()));
    expect(result.effects).toContainEqual({ kind: 'end', result: 'TIMED_OUT' });
  });
});
