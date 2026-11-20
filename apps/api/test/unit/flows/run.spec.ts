import { FlowGraphSchema, type FlowGraph } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import type { FlowEffect } from '../../../src/modules/flows/engine/effects.js';
import { MAX_STEPS_WITHOUT_INPUT, newSessionState, run, type RunContext } from '../../../src/modules/flows/engine/run.js';

// 003 T008: the engine core - starting, message and end steps, the step cap, effects and tokens.
const graph = (steps: unknown[], start = 'a'): FlowGraph => FlowGraphSchema.parse({ version: 1, start, steps });
const ctx = (g: FlowGraph): RunContext => ({ graph: g, render: (text) => text, answers: { today: '2026-11-20', normalizePhone: () => null } });
const kinds = (effects: FlowEffect[]) => effects.map((e) => e.kind);
const sends = (effects: FlowEffect[]) => effects.filter((e) => e.kind === 'send').map((e) => (e.kind === 'send' ? e.message : null));

describe('flow engine core', () => {
  it('runs message steps in order and completes at an end step', () => {
    const g = graph([
      { id: 'a', type: 'message', text: 'Hello', next: 'b' },
      { id: 'b', type: 'message', text: 'How can we help?', next: 'c' },
      { id: 'c', type: 'end' },
    ]);
    const result = run(newSessionState('s1'), { kind: 'start' }, ctx(g));
    expect(sends(result.effects)).toEqual([
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'How can we help?' },
    ]);
    expect(result.ended).toBe(true);
    expect(result.effects.at(-1)).toEqual({ kind: 'end', result: 'COMPLETED' });
    expect(result.state.currentStepId).toBeNull();
  });

  it('records each step it enters and the branch it leaves by', () => {
    const g = graph([
      { id: 'a', type: 'message', text: 'Hello', next: 'b' },
      { id: 'b', type: 'end' },
    ]);
    const { effects } = run(newSessionState('s1'), { kind: 'start' }, ctx(g));
    expect(kinds(effects)).toEqual(['stepEntered', 'send', 'stepLeft', 'stepEntered', 'stepLeft', 'end']);
    expect(effects.filter((e) => e.kind === 'stepLeft')).toEqual([
      { kind: 'stepLeft', stepId: 'a', branch: 'next' },
      { kind: 'stepLeft', stepId: 'b', branch: 'end' },
    ]);
  });

  it('completes the session when a branch leads nowhere', () => {
    const g = graph([{ id: 'a', type: 'message', text: 'Only this', next: null }]);
    const result = run(newSessionState('s1'), { kind: 'start' }, ctx(g));
    expect(result.ended).toBe(true);
    expect(result.effects.at(-1)).toEqual({ kind: 'end', result: 'COMPLETED' });
  });

  it('sends media with the text as its caption', () => {
    const g = graph([{ id: 'a', type: 'message', text: 'Our menu', mediaAssetId: '0190a000-0000-7000-8000-000000000009' }]);
    expect(sends(run(newSessionState('s1'), { kind: 'start' }, ctx(g)).effects)).toEqual([
      { type: 'media', mediaAssetId: '0190a000-0000-7000-8000-000000000009', caption: 'Our menu' },
    ]);
  });

  it('renders texts through the context', () => {
    const g = graph([{ id: 'a', type: 'message', text: 'Hi {first_name}', fallbacks: { first_name: 'there' } }]);
    const result = run(newSessionState('s1'), { kind: 'start' }, { graph: g, render: (text, fallbacks) => text.replace('{first_name}', fallbacks.first_name ?? ''), answers: { today: '2026-11-20', normalizePhone: () => null } });
    expect(sends(result.effects)).toEqual([{ type: 'text', text: 'Hi there' }]);
  });

  it(`ends with FAILED after ${MAX_STEPS_WITHOUT_INPUT} steps without customer input`, () => {
    const g = graph([
      { id: 'a', type: 'message', text: 'ping', next: 'b' },
      { id: 'b', type: 'message', text: 'pong', next: 'a' },
    ]);
    const result = run(newSessionState('s1'), { kind: 'start' }, ctx(g));
    expect(sends(result.effects)).toHaveLength(MAX_STEPS_WITHOUT_INPUT);
    expect(result.effects.at(-1)).toEqual({ kind: 'end', result: 'FAILED', reason: 'too many steps without a customer reply' });
  });

  it('fails cleanly on a graph without a start step', () => {
    const result = run(newSessionState('s1'), { kind: 'start' }, ctx(FlowGraphSchema.parse({ version: 1, start: null, steps: [] })));
    expect(result.effects).toEqual([{ kind: 'end', result: 'FAILED', reason: 'the flow has no start step' }]);
  });

  it('gives every start a new wait token and ignores input once ended', () => {
    const g = graph([{ id: 'a', type: 'end' }]);
    const started = run(newSessionState('s1'), { kind: 'start' }, ctx(g));
    expect(started.state.waitToken).toBe(1);
    const after = run(started.state, { kind: 'message', text: 'hello', replyId: null, contentType: 'TEXT' }, ctx(g));
    expect(after.effects).toEqual([]);
    expect(after.ended).toBe(false);
  });

  // 003 T040: hand-over asks for a person and ends the session.
  it('hands over with the note and ends HANDED_OVER', () => {
    const g = graph([
      { id: 'a', type: 'message', text: 'Let me get someone.', next: 'b' },
      { id: 'b', type: 'handover', note: '  Wants a callback  ' },
    ]);
    const result = run(newSessionState('s1'), { kind: 'start' }, ctx(g));
    expect(result.ended).toBe(true);
    expect(result.effects).toContainEqual({ kind: 'handover', stepId: 'b', note: 'Wants a callback' });
    expect(result.effects).toContainEqual({ kind: 'stepLeft', stepId: 'b', branch: 'handover' });
    expect(result.effects.at(-1)).toEqual({ kind: 'end', result: 'HANDED_OVER' });
    const quiet = run(newSessionState('s2'), { kind: 'start' }, ctx(graph([{ id: 'a', type: 'handover' }])));
    expect(quiet.effects).toContainEqual({ kind: 'handover', stepId: 'a' });
  });
});
