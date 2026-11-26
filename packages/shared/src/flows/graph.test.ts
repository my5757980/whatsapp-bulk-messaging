import { describe, expect, it } from 'vitest';
import { branchesOf, emptyGraph, FLOW_LIMITS, FlowGraphSchema, type FlowGraph } from './graph.js';

// 003 T006: the graph document of contracts/flow-graph.md (structure and limits; required content is
// a publish check in validate.ts, so incomplete drafts can still be saved).
const example = (): FlowGraph =>
  ({
    version: 1,
    start: 'hours',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'CONTAINS', phrases: ['hours'], canInterrupt: false }],
    steps: [
      {
        id: 'hours',
        type: 'buttons',
        position: { x: 0, y: 0 },
        text: 'We open 9–6, Monday to Saturday. Anything else?',
        buttons: [
          { key: 'loc', title: 'Location', next: 'where' },
          { key: 'human', title: 'Talk to us', next: 'agent' },
        ],
        timeoutMinutes: 60,
        onTimeout: null,
        onInvalid: null,
        fallbacks: {},
      },
      { id: 'where', type: 'message', position: { x: -200, y: 200 }, text: 'Find us at the marina.', mediaAssetId: null, fallbacks: {}, next: null },
      { id: 'agent', type: 'handover', position: { x: 200, y: 200 } },
    ],
  }) as FlowGraph;

const parse = (graph: unknown) => FlowGraphSchema.safeParse(graph);
const withStep = (step: Record<string, unknown>) => ({ ...example(), steps: [...example().steps, step] });

// Feature 008 (T045): the payment step.
describe('payment step', () => {
  const parse = (step: Record<string, unknown>) => FlowGraphSchema.safeParse({ version: 1, start: 'pay', triggers: [], steps: [{ id: 'pay', type: 'payment', ...step }, { id: 'thanks', type: 'message', text: 'Thanks' }] });
  it('takes a fixed, answer or attribute amount with paid and not-paid branches', () => {
    expect(parse({ amount: { source: 'static', minor: 9900 }, description: 'Booking fee', next: 'thanks' }).success).toBe(true);
    expect(parse({ amount: { source: 'answer', name: 'quote' }, description: 'Quote', next: 'thanks', onNotPaid: 'thanks' }).success).toBe(true);
    expect(parse({ amount: { source: 'attribute', key: 'balance' }, description: 'Balance' }).success).toBe(true);
    const parsed = parse({ description: 'x' });
    expect(parsed.success && parsed.data.steps[0]).toMatchObject({ amount: { source: 'static', minor: 10000 }, expiryMinutes: 60, next: null, onNotPaid: null });
  });
  it('keeps the expiry within the 24-hour window and refuses bad amounts', () => {
    expect(parse({ description: 'x', expiryMinutes: 1380 }).success).toBe(true);
    expect(parse({ description: 'x', expiryMinutes: 1381 }).success).toBe(false);
    expect(parse({ description: 'x', expiryMinutes: 29 }).success).toBe(false);
    expect(parse({ description: 'x', amount: { source: 'static', minor: 0 } }).success).toBe(false);
    expect(parse({ description: 'x', amount: { source: 'answer', name: 'Bad Name' } }).success).toBe(false);
    expect(parse({ description: 'x'.repeat(251) }).success).toBe(false);
  });
});

describe('FlowGraphSchema', () => {
  it('accepts the contract example and an empty draft', () => {
    expect(parse(example()).success).toBe(true);
    expect(parse(emptyGraph()).success).toBe(true);
  });

  it('fills defaults for optional fields', () => {
    const graph = FlowGraphSchema.parse({ version: 1, start: 'a', steps: [{ id: 'a', type: 'message', text: 'Hi' }] });
    expect(graph.triggers).toEqual([]);
    expect(graph.steps[0]).toMatchObject({ position: { x: 0, y: 0 }, fallbacks: {}, next: null });
  });

  it('accepts every step type', () => {
    const graph = {
      version: 1,
      start: 'q',
      triggers: [
        { id: 'p', kind: 'PATTERN', pattern: '^ORD-\\d{5}$', answerName: 'order_ref' },
        { id: 't', kind: 'TEMPLATE_BUTTON', templateId: '0190a000-0000-7000-8000-000000000001', buttonText: 'Yes, interested' },
        { id: 'f', kind: 'FIRST_MESSAGE', match: 'CONTAINS', phrases: ['saw your ad'], tagId: null, startFlow: true },
      ],
      steps: [
        { id: 'q', type: 'question', text: 'Your email?', answer: { kind: 'email' }, answerName: 'email', saveTo: { attributeKey: 'email' }, retryText: 'That does not look like an email.', next: 'l', onInvalid: 'h', onTimeout: 'e' },
        {
          id: 'l',
          type: 'list',
          text: 'Which branch?',
          buttonLabel: 'Choose',
          sections: [{ title: 'Dubai', rows: [{ key: 'marina', title: 'Dubai Marina', description: 'Open late', next: 'tg' }] }],
          sharedNext: null,
        },
        { id: 'tg', type: 'tags', add: ['0190a000-0000-7000-8000-000000000002'], remove: [], next: 'at' },
        { id: 'at', type: 'attributes', set: [{ key: 'branch', value: { source: 'answer', name: 'email' } }, { key: 'old', value: null }], next: 'c' },
        {
          id: 'c',
          type: 'condition',
          join: 'any',
          rules: [
            { subject: { kind: 'tag', tagId: '0190a000-0000-7000-8000-000000000002' }, op: 'is_present' },
            { subject: { kind: 'workingHours' }, op: 'inside' },
          ],
          yes: 'd',
          no: 'api',
        },
        { id: 'd', type: 'delay', seconds: 10, next: 'j' },
        { id: 'api', type: 'api', method: 'POST', url: 'https://example.test/orders', headers: [{ name: 'Authorization', value: 'Bearer {secret:0190a000-0000-7000-8000-000000000003}' }], body: '{"ref":"{answer:email}"}', map: [{ path: 'order.status', answerName: 'order_status' }], success: 'e', failed: 'h' },
        { id: 'j', type: 'jump', flowId: '0190a000-0000-7000-8000-000000000004' },
        { id: 'h', type: 'handover', note: 'Needs a person' },
        { id: 'e', type: 'end' },
      ],
    };
    const result = parse(graph);
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
  });

  it('accepts a Hand to AI agent step, which has no next step (004 T077)', () => {
    const agentId = '0190a000-0000-7000-8000-0000000000a1';
    const ai = { id: 'ai', type: 'aiAgent', agentId, openingMessage: 'Our assistant will take it from here.' };
    const result = parse(withStep(ai));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(true);
    const step = result.data!.steps.find((s) => s.id === 'ai')!;
    expect(step).toMatchObject({ type: 'aiAgent', agentId, openingMessage: 'Our assistant will take it from here.' });
    expect(branchesOf(step)).toEqual([]);
    expect(parse(withStep({ id: 'ai', type: 'aiAgent' })).data?.steps.find((s) => s.id === 'ai')).toMatchObject({ agentId: null });
    expect(parse(withStep({ ...ai, next: 'end' })).success).toBe(false);
    expect(parse(withStep({ ...ai, openingMessage: 'x'.repeat(1025) })).success).toBe(false);
    expect(parse(withStep({ ...ai, agentId: 'not-a-uuid' })).success).toBe(false);
  });

  it('rejects unknown fields, bad ids and duplicate step ids', () => {
    expect(parse({ ...example(), extra: true }).success).toBe(false);
    expect(parse(withStep({ id: 'Bad Id', type: 'end' })).success).toBe(false);
    expect(parse(withStep({ id: 'where', type: 'end' })).success).toBe(false);
    expect(parse(withStep({ id: 'x', type: 'end', colour: 'red' })).success).toBe(false);
  });

  it('rejects a start step or a branch that does not exist', () => {
    expect(parse({ ...example(), start: 'missing' }).success).toBe(false);
    expect(parse(withStep({ id: 'x', type: 'message', text: 'Hi', next: 'nowhere' })).success).toBe(false);
  });

  it('enforces the WhatsApp limits on buttons and lists', () => {
    const button = (n: number) => ({ key: `b${n}`, title: `B${n}`, next: null });
    expect(parse(withStep({ id: 'x', type: 'buttons', text: 'Pick', buttons: [1, 2, 3, 4].map(button) })).success).toBe(false);
    expect(parse(withStep({ id: 'x', type: 'buttons', text: 'Pick', buttons: [{ key: 'b', title: 'x'.repeat(FLOW_LIMITS.buttonTitle + 1), next: null }] })).success).toBe(false);
    expect(parse(withStep({ id: 'x', type: 'buttons', text: 'x'.repeat(FLOW_LIMITS.interactiveBody + 1), buttons: [button(1)] })).success).toBe(false);
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ key: `r${i}`, title: `Row ${i}`, next: null }));
    expect(parse(withStep({ id: 'x', type: 'list', text: 'Pick', buttonLabel: 'Open', sections: [{ rows: rows(6) }, { rows: rows(5).map((r) => ({ ...r, key: `s${r.key}` })) }] })).success).toBe(false);
    expect(parse(withStep({ id: 'x', type: 'list', text: 'Pick', buttonLabel: 'Open', sections: [{ rows: [{ key: 'r', title: 'x'.repeat(25), next: null }] }] })).success).toBe(false);
    expect(parse(withStep({ id: 'x', type: 'buttons', text: 'Pick', buttons: [button(1), { ...button(1) }] })).success).toBe(false); // duplicate key
  });

  it('rejects more than 200 steps', () => {
    const steps = Array.from({ length: FLOW_LIMITS.steps + 1 }, (_, i) => ({ id: `s${i}`, type: 'end' }));
    expect(parse({ version: 1, start: 's0', triggers: [], steps }).success).toBe(false);
  });

  it('lists the branches of a step', () => {
    const graph = example();
    expect(branchesOf(graph.steps[0]!)).toEqual([
      { branch: 'loc', target: 'where', required: true },
      { branch: 'human', target: 'agent', required: true },
      { branch: 'onTimeout', target: null, required: false },
      { branch: 'onInvalid', target: null, required: false },
    ]);
    expect(branchesOf(graph.steps[2]!)).toEqual([]);
  });
});
