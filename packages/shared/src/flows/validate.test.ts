import { describe, expect, it } from 'vitest';
import { FlowGraphSchema } from './graph.js';
import { validateForPublish, type Problem } from './validate.js';

// 003 T015: publish checks (FR-003). Each problem names its code and step or trigger.
const graph = (raw: Record<string, unknown>) => FlowGraphSchema.parse({ version: 1, ...raw });
const codes = (problems: Problem[]) => problems.map((p) => `${p.code}:${p.stepId ?? p.triggerId ?? '-'}`).sort();

describe('validateForPublish', () => {
  it('accepts a complete flow', () => {
    const g = graph({
      start: 'hours',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'CONTAINS', phrases: ['hours'] }],
      steps: [
        { id: 'hours', type: 'buttons', text: 'Anything else?', buttons: [{ key: 'loc', title: 'Location', next: 'where' }, { key: 'human', title: 'Talk to us', next: 'agent' }] },
        { id: 'where', type: 'message', text: 'Find us at the marina.' },
        { id: 'agent', type: 'handover' },
      ],
    });
    expect(validateForPublish(g)).toEqual([]);
  });

  it('needs a start step', () => {
    expect(codes(validateForPublish(graph({ start: null, steps: [] })))).toEqual(['NO_START:-']);
  });

  it('reports unreachable steps', () => {
    const g = graph({ start: 'a', steps: [{ id: 'a', type: 'message', text: 'Hi' }, { id: 'lost', type: 'message', text: 'Nobody gets here' }] });
    expect(codes(validateForPublish(g))).toEqual(['UNREACHABLE_STEP:lost']);
  });

  it('reports required branches that lead nowhere', () => {
    const g = graph({
      start: 'b',
      steps: [{ id: 'b', type: 'buttons', text: 'Pick', buttons: [{ key: 'one', title: 'One', next: null }, { key: 'two', title: 'Two', next: 'end' }] }, { id: 'end', type: 'end' }],
    });
    const problems = validateForPublish(g);
    expect(codes(problems)).toEqual(['BRANCH_NOT_CONNECTED:b']);
    expect(problems[0]).toMatchObject({ field: 'one' });
  });

  it('reports missing content', () => {
    const g = graph({
      start: 'm',
      steps: [
        { id: 'm', type: 'message', text: '   ', next: 'b' },
        { id: 'b', type: 'buttons', text: 'Pick one', buttons: [] },
      ],
    });
    expect(codes(validateForPublish(g))).toEqual(['MISSING_CONTENT:b', 'MISSING_CONTENT:m']);
  });

  it('reports buttons without titles and keyword triggers without phrases', () => {
    const g = graph({
      start: 'b',
      triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: ['  '] }],
      steps: [{ id: 'b', type: 'buttons', text: 'Pick', buttons: [{ key: 'x', title: '', next: 'e' }] }, { id: 'e', type: 'end' }],
    });
    expect(codes(validateForPublish(g))).toEqual(['MISSING_CONTENT:b', 'MISSING_CONTENT:kw']);
  });

  it('refuses reserved keywords as triggers', () => {
    const g = graph({ start: 'a', triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: ['Stop', 'menu'] }], steps: [{ id: 'a', type: 'message', text: 'Menu' }] });
    const problems = validateForPublish(g, { reservedKeywords: ['STOP', 'START', 'agent'] });
    expect(codes(problems)).toEqual(['RESERVED_KEYWORD:kw']);
    expect(problems[0]!.message).toContain('stop');
  });

  // 003 T046: a loop must wait for the customer somewhere (a question, buttons or a list).
  it('refuses a loop that never waits for the customer, and allows one through a question', () => {
    const spinning = graph({
      start: 'a',
      steps: [
        { id: 'a', type: 'message', text: 'Hi', next: 'b' },
        { id: 'b', type: 'delay', seconds: 5, next: 'a' },
      ],
    });
    expect(codes(validateForPublish(spinning))).toEqual(['LOOP_WITHOUT_WAIT:a']);
    const asking = graph({
      start: 'a',
      steps: [
        { id: 'a', type: 'message', text: 'Hi', next: 'q' },
        { id: 'q', type: 'question', text: 'Again?', answerName: 'again', retryText: 'Please answer.', next: 'a' },
      ],
    });
    expect(validateForPublish(asking)).toEqual([]);
  });

  it('needs every condition rule complete', () => {
    const g = graph({
      start: 'c',
      steps: [
        { id: 'c', type: 'condition', rules: [{ subject: { kind: 'attribute', key: 'city' }, op: 'equals' }], yes: 'y', no: 'n' },
        { id: 'y', type: 'end' },
        { id: 'n', type: 'end' },
      ],
    });
    expect(codes(validateForPublish(g))).toEqual(['MISSING_CONTENT:c']);
    const wrongOp = graph({ start: 'c', steps: [{ id: 'c', type: 'condition', rules: [{ subject: { kind: 'tag', tagId: '0193a0de-0000-7000-8000-000000000001' }, op: 'equals', value: 'x' }], yes: 'y', no: 'n' }, { id: 'y', type: 'end' }, { id: 'n', type: 'end' }] });
    expect(codes(validateForPublish(wrongOp))).toEqual(['MISSING_CONTENT:c']);
  });

  // 003 T035: answer names are unique, so {answer:name} always means one step.
  it('reports an answer name used by two steps', () => {
    const g = graph({
      start: 'q1',
      steps: [
        { id: 'q1', type: 'question', text: 'Your name?', answerName: 'name', retryText: 'Please type your name.', next: 'q2' },
        { id: 'q2', type: 'list', text: 'Which branch?', buttonLabel: 'Branches', sections: [{ rows: [{ key: 'dxb', title: 'Dubai' }] }], sharedNext: 'q3', answerName: 'name' },
        { id: 'q3', type: 'buttons', text: 'Again?', buttons: [{ key: 'yes', title: 'Yes', next: null }], answerName: 'other' },
      ],
    });
    const problems = validateForPublish(g).filter((p) => p.code !== 'BRANCH_NOT_CONNECTED');
    expect(codes(problems)).toEqual(['DUPLICATE_ANSWER_NAME:q2']);
    expect(problems[0]).toMatchObject({ field: 'answerName' });
  });
});
