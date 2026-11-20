import { FlowGraphSchema, type FlowGraph } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import type { FlowEffect } from '../../../src/modules/flows/engine/effects.js';
import { newSessionState, replyIdFor, run, type RunContext, type SessionState } from '../../../src/modules/flows/engine/run.js';

// 003 T017: buttons steps - waiting, choosing by reply id or title, stale taps, invalid answers, timeouts.
const graph = (onInvalid: string | null = null, onTimeout: string | null = null): FlowGraph =>
  FlowGraphSchema.parse({
    version: 1,
    start: 'menu',
    steps: [
      {
        id: 'menu',
        type: 'buttons',
        text: 'Hi {first_name}, anything else?',
        header: 'Opening hours',
        buttons: [
          { key: 'loc', title: 'Location', next: 'where' },
          { key: 'human', title: 'Talk to us', next: 'bye' },
        ],
        answerName: 'choice',
        timeoutMinutes: 30,
        onInvalid,
        onTimeout,
      },
      { id: 'where', type: 'message', text: 'Find us at the marina.', next: null },
      { id: 'bye', type: 'message', text: 'A person will reply soon.', next: null },
      { id: 'again', type: 'message', text: 'Please tap a button.', next: 'menu' },
      { id: 'late', type: 'message', text: 'Write any time.', next: null },
    ],
  });
const ctx = (g: FlowGraph): RunContext => ({ graph: g, render: (text) => text.replace('{first_name}', 'Sara'), answers: { today: '2026-11-20', normalizePhone: () => null } });
const message = (replyId: string | null, text: string | null = 'x') => ({ kind: 'message' as const, text, replyId, contentType: replyId ? 'BUTTON_REPLY' : 'TEXT' });
const sendsOf = (effects: FlowEffect[]) => effects.flatMap((e) => (e.kind === 'send' ? [e.message] : []));

function waiting(g = graph()): SessionState {
  return run(newSessionState('11111111-1111-7111-8111-111111111111'), { kind: 'start' }, ctx(g)).state;
}

describe('buttons steps', () => {
  it('sends the buttons with reply ids, waits for input and schedules the timeout', () => {
    const result = run(newSessionState('11111111-1111-7111-8111-111111111111'), { kind: 'start' }, ctx(graph()));
    expect(result.ended).toBe(false);
    expect(result.state).toMatchObject({ currentStepId: 'menu', wait: 'INPUT', waitToken: 2 });
    expect(sendsOf(result.effects)).toEqual([
      {
        type: 'buttons',
        text: 'Hi Sara, anything else?',
        header: 'Opening hours',
        buttons: [
          { id: replyIdFor(result.state, 'loc'), title: 'Location' },
          { id: replyIdFor(result.state, 'human'), title: 'Talk to us' },
        ],
      },
    ]);
    expect(replyIdFor(result.state, 'loc')).toBe('s:11111111-1111-7111-8111-111111111111:2:loc');
    expect(result.effects).toContainEqual({ kind: 'schedule', stepId: 'menu', purpose: 'timeout', delayMs: 30 * 60_000 });
  });

  it('follows the tapped button and stores the answer', () => {
    const state = waiting();
    const result = run(state, message(replyIdFor(state, 'loc'), 'Location'), ctx(graph()));
    expect(result.consumed).toBe(true);
    expect(sendsOf(result.effects)).toEqual([{ type: 'text', text: 'Find us at the marina.' }]);
    expect(result.effects).toContainEqual({ kind: 'stepLeft', stepId: 'menu', branch: 'loc' });
    expect(result.state.answers).toEqual({ choice: 'Location' });
    expect(result.ended).toBe(true);
  });

  it('accepts a typed answer that equals a button title', () => {
    const result = run(waiting(), message(null, '  talk TO us '), ctx(graph()));
    expect(sendsOf(result.effects)).toEqual([{ type: 'text', text: 'A person will reply soon.' }]);
  });

  it('ignores stale taps from an older wait or another session', () => {
    const state = waiting();
    const old = run(state, message(`s:${state.sessionId}:${state.waitToken - 1}:loc`), ctx(graph()));
    expect(old).toMatchObject({ consumed: false, ended: false, effects: [] });
    const other = run(state, message('s:22222222-2222-7222-8222-222222222222:2:loc'), ctx(graph()));
    expect(other).toMatchObject({ consumed: false, effects: [] });
  });

  it('follows the invalid branch for other answers, or ends quietly without one', () => {
    const withBranch = run(waiting(graph('again')), message(null, 'what?'), ctx(graph('again')));
    expect(sendsOf(withBranch.effects)[0]).toEqual({ type: 'text', text: 'Please tap a button.' });
    expect(withBranch.state.currentStepId).toBe('menu');

    const without = run(waiting(), message(null, 'what?'), ctx(graph()));
    expect(sendsOf(without.effects)).toEqual([]);
    expect(without.effects.at(-1)).toEqual({ kind: 'end', result: 'FAILED', reason: 'no valid answer' });
  });

  it('follows the timeout branch, or ends as timed out', () => {
    const state = waiting(graph(null, 'late'));
    const result = run(state, { kind: 'timer', token: state.waitToken }, ctx(graph(null, 'late')));
    expect(sendsOf(result.effects)).toEqual([{ type: 'text', text: 'Write any time.' }]);
    const plain = waiting();
    expect(run(plain, { kind: 'timer', token: plain.waitToken }, ctx(graph())).effects.at(-1)).toEqual({ kind: 'end', result: 'TIMED_OUT' });
    expect(run(plain, { kind: 'timer', token: plain.waitToken - 1 }, ctx(graph())).effects).toEqual([]);
  });

  it('resets the step counter when the customer answers', () => {
    const state = waiting();
    const result = run(state, message(replyIdFor(state, 'loc')), ctx(graph()));
    expect(result.state.stepsSinceInput).toBe(1);
  });
});
