import { FlowGraphSchema, type FlowGraph } from '@wbm/shared';
import { describe, expect, it } from 'vitest';
import type { FlowEffect } from '../../../src/modules/flows/engine/effects.js';
import { newSessionState, run, type RunContext } from '../../../src/modules/flows/engine/run.js';

// 004 T078: the Hand to AI agent step (FR-033) sends its opening message, asks the session service to
// start the agent's AI conversation, and ends the session HANDED_TO_AI.
const AGENT = '0190a000-0000-7000-8000-0000000000a1';
const graph = (steps: unknown[], start = 'a'): FlowGraph => FlowGraphSchema.parse({ version: 1, start, steps });
const ctx = (g: FlowGraph): RunContext => ({ graph: g, render: (text) => text.replace('{first_name}', 'Sara'), answers: { today: '2026-11-21', normalizePhone: () => null } });
const kinds = (effects: FlowEffect[]) => effects.map((e) => e.kind);

describe('Hand to AI agent step (T078)', () => {
  it('sends the opening message, hands the chat to the agent and ends HANDED_TO_AI', () => {
    const g = graph([
      { id: 'a', type: 'message', text: 'Thanks for your order!', next: 'ai' },
      { id: 'ai', type: 'aiAgent', agentId: AGENT, openingMessage: 'Hi {first_name}, our assistant will help you from here.' },
    ]);
    const result = run(newSessionState('s1'), { kind: 'start' }, ctx(g));
    expect(kinds(result.effects)).toEqual(['stepEntered', 'send', 'stepLeft', 'stepEntered', 'send', 'handToAi', 'stepLeft', 'end']);
    expect(result.effects.filter((e) => e.kind === 'send').map((e) => (e.kind === 'send' ? e.message : null))).toEqual([
      { type: 'text', text: 'Thanks for your order!' },
      { type: 'text', text: 'Hi Sara, our assistant will help you from here.' },
    ]);
    expect(result.effects).toContainEqual({ kind: 'handToAi', stepId: 'ai', agentId: AGENT });
    expect(result.effects.at(-1)).toEqual({ kind: 'end', result: 'HANDED_TO_AI' });
    expect(result.ended).toBe(true);
    expect(result.state.currentStepId).toBeNull();
  });

  it('hands over without a message when there is no opening message', () => {
    const result = run(newSessionState('s1'), { kind: 'start' }, ctx(graph([{ id: 'a', type: 'aiAgent', agentId: AGENT }])));
    expect(kinds(result.effects)).toEqual(['stepEntered', 'handToAi', 'stepLeft', 'end']);
    expect(result.effects.at(-1)).toEqual({ kind: 'end', result: 'HANDED_TO_AI' });
  });

  it('only ends when no agent was chosen (publishing refuses such a flow)', () => {
    const result = run(newSessionState('s1'), { kind: 'start' }, ctx(graph([{ id: 'a', type: 'aiAgent' }])));
    expect(kinds(result.effects)).toEqual(['stepEntered', 'stepLeft', 'end']);
  });
});
