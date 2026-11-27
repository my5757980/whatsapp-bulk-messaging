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
    expect(requestOf(effects)).toEqual({ kind: 'requestPayment', stepId: 'pay', amount: { minor: 9900 }, description: 'Booking for Friday', expiryMinutes: 120, chatOrderId: null });
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

// T086 (feature 008 US8): products and the catalog wait for a cart, forms for their answer.
describe('commerce steps', () => {
  const cart = { chatOrderId: '0196f1f0-0000-7000-8000-0000000000aa', totalMinor: 15400, currency: 'aed', items: [] };
  const shop = [
    { id: 'list', type: 'product', header: 'New in', body: 'Pick what you like', sections: [{ title: '', retailerIds: ['shp-101', 'shp-102'] }], timeoutMinutes: 30, next: 'pay', onTimeout: 'bye' },
    { id: 'pay', type: 'payment', amount: { source: 'cartTotal' }, description: 'Your order', expiryMinutes: 120, next: 'thanks', onNotPaid: 'bye' },
    { id: 'thanks', type: 'message', text: 'Thank you, {answer:cart_total} received' },
    { id: 'bye', type: 'message', text: 'Maybe next time' },
  ];

  it('sends the product list, waits for the cart, then charges the cart total for its order', () => {
    const g = graph(shop, 'list');
    const { state, effects } = started(g, {});
    expect(effects).toContainEqual({ kind: 'send', stepId: 'list', message: { type: 'products', header: 'New in', body: 'Pick what you like', footer: '', sections: [{ title: '', retailerIds: ['shp-101', 'shp-102'] }] } });
    expect(effects).toContainEqual({ kind: 'schedule', stepId: 'list', purpose: 'timeout', delayMs: 30 * 60_000 });
    expect(state.wait).toBe('ORDER');
    expect(run(state, { kind: 'message', text: 'hi', replyId: null, contentType: 'TEXT' }, ctx(g)).effects).toEqual([]);
    const after = run(state, { kind: 'order', token: state.waitToken, cart }, ctx(g));
    expect(requestOf(after.effects)).toEqual({ kind: 'requestPayment', stepId: 'pay', amount: { minor: 15400 }, description: 'Your order', expiryMinutes: 120, chatOrderId: cart.chatOrderId });
    expect(after.state.answers).toMatchObject({ cart_total: '154.00', cart_currency: 'AED' });
  });

  it('takes the timeout branch when no cart arrives, and ignores stale carts', () => {
    const g = graph(shop, 'list');
    const { state } = started(g, {});
    expect(run(state, { kind: 'order', token: state.waitToken - 1, cart }, ctx(g)).effects).toEqual([]);
    expect(sendsOf(run(state, { kind: 'timer', token: state.waitToken }, ctx(g)).effects)).toEqual(['Maybe next time']);
  });

  it('sends the catalog and waits for a cart', () => {
    const g = graph([{ id: 'cat', type: 'catalog', body: 'Browse', thumbnailRetailerId: 'shp-101', timeoutMinutes: 60, next: 'thanks', onTimeout: null }, shop[2]], 'cat');
    const { state, effects } = started(g, {});
    expect(effects).toContainEqual({ kind: 'send', stepId: 'cat', message: { type: 'catalog', body: 'Browse', footer: '', thumbnailRetailerId: 'shp-101' } });
    expect(sendsOf(run(state, { kind: 'order', token: state.waitToken, cart }, ctx(g)).effects)).toEqual(['Thank you, 154.00 received']);
  });

  it('sends a form, waits for its answer, and keeps the answers under the prefix', () => {
    const formId = '0196f1f0-0000-7000-8000-0000000000bb';
    const g = graph([{ id: 'ask', type: 'form', formId, body: 'Tell us about you', cta: 'Open', answerPrefix: 'lead', timeoutMinutes: 60, next: 'hello', onTimeout: null }, { id: 'hello', type: 'message', text: 'Hello {answer:lead_name}' }], 'ask');
    const { state, effects } = started(g, {});
    expect(effects).toContainEqual({ kind: 'send', stepId: 'ask', message: { type: 'form', formId, header: '', body: 'Tell us about you', cta: 'Open' } });
    expect(state.wait).toBe('FORM');
    expect(sendsOf(run(state, { kind: 'form', token: state.waitToken, answers: { name: 'Sara', topics: ['a', 'b'] } }, ctx(g)).effects)).toEqual(['Hello Sara']);
    const timedOut = run(state, { kind: 'timer', token: state.waitToken }, ctx(g));
    expect(timedOut.ended).toBe(true);
  });
});
