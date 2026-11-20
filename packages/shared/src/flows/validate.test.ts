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
});
