import { FlowGraphSchema, type FlowGraph } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import type { FlowEffect } from '../../../src/modules/flows/engine/effects.js';
import { newSessionState, run, type FlowFacts, type RunContext, type SessionState } from '../../../src/modules/flows/engine/run.js';

// T045 (feature 008 US3, research R13): the payment step asks for a payment and waits; a paid result
// goes to next, a not-paid one to onNotPaid (or ends the session); stale and unrelated inputs do nothing.
const facts: FlowFacts = {
  fields: { name: 'Sara', phone: '+971501234567' },
  attributes: { balance: '250.50' },
  tagIds: [],
  consent: 'OPTED_IN',
  workingHours: { hours: {}, timezone: 'Asia/Dubai' },
  now: new Date('2026-11-25T08:00:00Z'),
};
const graph = (steps: unknown[], start = 'pay'): FlowGraph => FlowGraphSchema.parse({ version: 1, start, steps });
const ctx = (g: FlowGraph): RunContext => ({
  graph: g,
  render: (text, _fallbacks, answers) => text.replace(/\{answer:([a-z_]+)\}/g, (_m, name: string) => String(answers[name] ?? '')),
  answers: { today: '2026-11-25', normalizePhone: () => null },
  facts,
});
const requestOf = (effects: FlowEffect[]) => effects.find((e) => e.kind === 'requestPayment');
const sendsOf = (effects: FlowEffect[]) => effects.flatMap((e) => (e.kind === 'send' && e.message.type === 'text' ? [e.message.text] : []));

const steps = [
  { id: 'pay', type: 'payment', amount: { source: 'static', minor: 9900 }, description: 'Booking for {answer:day}', expiryMinutes: 120, next: 'thanks', onNotPaid: 'sorry' },
  { id: 'thanks', type: 'message', text: 'Paid, see you soon' },
  { id: 'sorry', type: 'message', text: 'The link expired' },
];

function started(g: FlowGraph, answers: Record<string, unknown> = { day: 'Friday' }): { state: SessionState; effects: FlowEffect[] } {
  const result = run({ ...newSessionState('s1'), answers }, { kind: 'start' }, ctx(g));
  return { state: result.state, effects: result.effects };
}

describe('payment step', () => {
  it('asks for the payment with the rendered text and waits', () => {
    const { state, effects } = started(graph(steps));
    expect(requestOf(effects)).toEqual({ kind: 'requestPayment', stepId: 'pay', amount: { minor: 9900 }, description: 'Booking for Friday', expiryMinutes: 120 });
    expect(state).toMatchObject({ currentStepId: 'pay', wait: 'PAYMENT', ended: false });
    expect(sendsOf(effects)).toEqual([]);
  });

  it('goes to next when paid and to onNotPaid when not', () => {
    const g = graph(steps);
    const { state } = started(g);
    const paid = run(state, { kind: 'payment', token: state.waitToken, paid: true }, ctx(g));
    expect(sendsOf(paid.effects)).toEqual(['Paid, see you soon']);
    const notPaid = run(state, { kind: 'payment', token: state.waitToken, paid: false }, ctx(g));
    expect(sendsOf(notPaid.effects)).toEqual(['The link expired']);
  });

  it('ends the session when not paid and no branch is set', () => {
    const g = graph([{ ...steps[0], onNotPaid: null }, steps[1]]);
    const { state } = started(g);
    const result = run(state, { kind: 'payment', token: state.waitToken, paid: false }, ctx(g));
    expect(result.ended).toBe(true);
    expect(result.effects.at(-1)).toMatchObject({ kind: 'end', result: 'TIMED_OUT' });
  });

  it('ignores stale tokens, messages and timers while waiting', () => {
    const g = graph(steps);
    const { state } = started(g);
    expect(run(state, { kind: 'payment', token: state.waitToken - 1, paid: true }, ctx(g)).effects).toEqual([]);
    expect(run(state, { kind: 'message', text: 'hello', replyId: null, contentType: 'TEXT' }, ctx(g)).effects).toEqual([]);
    expect(run(state, { kind: 'timer', token: state.waitToken }, ctx(g)).effects).toEqual([]);
  });

  it('reads the amount from an answer or an attribute in major units, and none when missing', () => {
    const fromAnswer = started(graph([{ ...steps[0], amount: { source: 'answer', name: 'quote' } }, steps[1], steps[2]]), { quote: '149.5' });
    expect(requestOf(fromAnswer.effects)).toMatchObject({ amount: { major: 149.5 } });
    const fromAttribute = started(graph([{ ...steps[0], amount: { source: 'attribute', key: 'balance' } }, steps[1], steps[2]]));
    expect(requestOf(fromAttribute.effects)).toMatchObject({ amount: { major: 250.5 } });
    const missing = started(graph([{ ...steps[0], amount: { source: 'answer', name: 'quote' } }, steps[1], steps[2]]), {});
    expect(requestOf(missing.effects)).toMatchObject({ amount: null });
  });
});
