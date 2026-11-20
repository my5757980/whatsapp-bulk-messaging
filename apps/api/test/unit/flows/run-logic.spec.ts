import { FlowGraphSchema, type FlowGraph } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import type { FlowEffect } from '../../../src/modules/flows/engine/effects.js';
import { newSessionState, run, type FlowFacts, type RunContext } from '../../../src/modules/flows/engine/run.js';

// 003 T046: logic steps - tags and attribute effects, condition branches (seeing changes made earlier
// in the same run), delays that wait for their timer, jumps and the end step.
const VIP = '0193a0de-0000-7000-8000-000000000001';
const NEWS = '0193a0de-0000-7000-8000-000000000002';
const TARGET = '0193a0de-0000-7000-8000-0000000000ff';
// Monday 2026-11-23 10:30 in Dubai.
const MORNING = new Date('2026-11-23T06:30:00Z');

const facts = (overrides: Partial<FlowFacts> = {}): FlowFacts => ({
  fields: { name: 'Sara Khan', phone: '+971501234567' },
  attributes: { city: 'Dubai' },
  tagIds: [],
  consent: 'OPTED_IN',
  workingHours: { hours: { mon: [['09:00', '18:00']] }, timezone: 'Asia/Dubai' },
  now: MORNING,
  ...overrides,
});
const graph = (steps: unknown[], start = 'a'): FlowGraph => FlowGraphSchema.parse({ version: 1, start, steps });
const ctx = (g: FlowGraph, f: FlowFacts = facts()): RunContext => ({
  graph: g,
  render: (text, _fallbacks, answers, saved) =>
    text.replace(/\{attr:([a-z_]+)\}/g, (_m, key: string) => String(saved?.[key] ?? f.attributes[key] ?? '')).replace(/\{answer:([a-z_]+)\}/g, (_m, name: string) => String(answers[name] ?? '')),
  answers: { today: '2026-11-23', normalizePhone: () => null },
  facts: f,
});
const sendsOf = (effects: FlowEffect[]) => effects.flatMap((e) => (e.kind === 'send' && e.message.type === 'text' ? [e.message.text] : []));
const start = (g: FlowGraph, f?: FlowFacts) => run({ ...newSessionState('s1'), answers: { topic: 'Refund' } }, { kind: 'start' }, ctx(g, f));

describe('tags and attributes', () => {
  it('emits tag and attribute effects with fixed values, answers, contact fields and clearing', () => {
    const g = graph([
      { id: 'a', type: 'tags', add: [VIP], remove: [NEWS], next: 'b' },
      {
        id: 'b',
        type: 'attributes',
        set: [
          { key: 'city', value: { source: 'static', value: 'Sharjah' } },
          { key: 'topic', value: { source: 'answer', name: 'topic' } },
          { key: 'full_name', value: { source: 'field', key: 'name' } },
          { key: 'old', value: null },
        ],
        next: 'c',
      },
      { id: 'c', type: 'message', text: 'City: {attr:city}', next: null },
    ]);
    const result = start(g);
    expect(result.effects).toContainEqual({ kind: 'tags', stepId: 'a', add: [VIP], remove: [NEWS] });
    expect(result.effects).toContainEqual({ kind: 'setAttributes', stepId: 'b', values: { city: 'Sharjah', topic: 'Refund', full_name: 'Sara Khan', old: null } });
    expect(sendsOf(result.effects)).toEqual(['City: Sharjah']);
    expect(result.effects.at(-1)).toEqual({ kind: 'end', result: 'COMPLETED' });
  });
});

describe('conditions', () => {
  const branching = (rules: unknown[], join = 'all') =>
    graph([
      { id: 'a', type: 'condition', join, rules, yes: 'yes', no: 'no' },
      { id: 'yes', type: 'message', text: 'Yes branch', next: null },
      { id: 'no', type: 'message', text: 'No branch', next: null },
    ]);

  it('takes the yes branch when the rules hold and the no branch otherwise', () => {
    const g = branching([
      { subject: { kind: 'workingHours' }, op: 'inside' },
      { subject: { kind: 'tag', tagId: VIP }, op: 'is_present' },
    ]);
    expect(sendsOf(start(g, facts({ tagIds: [VIP] })).effects)).toEqual(['Yes branch']);
    expect(sendsOf(start(g, facts()).effects)).toEqual(['No branch']);
    expect(start(g, facts()).effects).toContainEqual({ kind: 'stepLeft', stepId: 'a', branch: 'no' });
    const evening = new Date('2026-11-23T15:30:00Z');
    expect(sendsOf(start(g, facts({ tagIds: [VIP], now: evening })).effects)).toEqual(['No branch']);
  });

  it('joins with any, and reads answers and contact fields', () => {
    const g = branching(
      [
        { subject: { kind: 'answer', name: 'topic' }, op: 'equals', value: 'refund' },
        { subject: { kind: 'field', key: 'name' }, op: 'is_empty' },
      ],
      'any',
    );
    expect(sendsOf(start(g).effects)).toEqual(['Yes branch']);
  });

  it('sees tags and attributes changed earlier in the same run', () => {
    const g = graph([
      { id: 't', type: 'tags', add: [VIP], next: 'v' },
      { id: 'v', type: 'attributes', set: [{ key: 'city', value: { source: 'static', value: 'Ajman' } }], next: 'a' },
      { id: 'a', type: 'condition', rules: [{ subject: { kind: 'tag', tagId: VIP }, op: 'is_present' }, { subject: { kind: 'attribute', key: 'city' }, op: 'equals', value: 'ajman' }], yes: 'yes', no: 'no' },
      { id: 'yes', type: 'message', text: 'Yes branch', next: null },
      { id: 'no', type: 'message', text: 'No branch', next: null },
    ], 't');
    expect(sendsOf(start(g).effects)).toEqual(['Yes branch']);
  });
});

describe('delays', () => {
  const delayed = graph([
    { id: 'a', type: 'message', text: 'One moment…', next: 'd' },
    { id: 'd', type: 'delay', seconds: 5, next: 'b' },
    { id: 'b', type: 'message', text: 'Here is your answer.', next: null },
  ]);

  it('waits for its timer, ignores messages meanwhile, then continues', () => {
    const waiting = start(delayed);
    expect(waiting.state).toMatchObject({ wait: 'DELAY', currentStepId: 'd' });
    expect(waiting.effects).toContainEqual({ kind: 'schedule', stepId: 'd', purpose: 'delay', delayMs: 5_000 });
    expect(sendsOf(waiting.effects)).toEqual(['One moment…']);

    const message = run(waiting.state, { kind: 'message', text: 'hello?', replyId: null, contentType: 'TEXT' }, ctx(delayed));
    expect(message).toMatchObject({ consumed: false, effects: [] });

    expect(run(waiting.state, { kind: 'timer', token: waiting.state.waitToken - 1 }, ctx(delayed)).effects).toEqual([]);
    const done = run(waiting.state, { kind: 'timer', token: waiting.state.waitToken }, ctx(delayed));
    expect(done.effects).toContainEqual({ kind: 'stepLeft', stepId: 'd', branch: 'next' });
    expect(sendsOf(done.effects)).toEqual(['Here is your answer.']);
    expect(done.ended).toBe(true);
  });
});

describe('jumps and the end step', () => {
  it('a jump asks to continue in the target flow and ends this session COMPLETED with branch "jumped"', () => {
    const result = start(graph([{ id: 'a', type: 'jump', flowId: TARGET }]));
    expect(result.effects).toEqual([
      { kind: 'stepEntered', stepId: 'a' },
      { kind: 'jump', stepId: 'a', flowId: TARGET },
      { kind: 'stepLeft', stepId: 'a', branch: 'jumped' },
      { kind: 'end', result: 'COMPLETED' },
    ]);
  });

  it('a jump without a target fails the session', () => {
    expect(start(graph([{ id: 'a', type: 'jump' }])).effects.at(-1)).toEqual({ kind: 'end', result: 'FAILED', reason: 'no flow to continue in' });
  });

  it('the end step completes the session', () => {
    expect(start(graph([{ id: 'a', type: 'end' }])).effects.at(-1)).toEqual({ kind: 'end', result: 'COMPLETED' });
  });
});
