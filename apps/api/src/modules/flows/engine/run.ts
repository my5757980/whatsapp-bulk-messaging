import type { FlowGraph, FlowStep } from '@wbm/shared';
import type { FlowEffect, FlowSessionResult } from './effects.js';

// The flow interpreter (003 research R4, T009): pure. Given a session's state, one input and the
// version's graph, it returns the next state and the effects to apply. It runs steps until it needs
// the customer, a timer or an API reply, or the session ends. Later stories add step types.

/** FR-033: a session that runs this many steps without a customer reply ends as FAILED. */
export const MAX_STEPS_WITHOUT_INPUT = 50;

export type FlowWait = 'NONE' | 'INPUT' | 'DELAY' | 'API';

export interface SessionState {
  sessionId: string;
  currentStepId: string | null;
  wait: FlowWait;
  /** +1 whenever the session starts or begins a new wait; timers and reply ids carry it. */
  waitToken: number;
  retries: number;
  stepsSinceInput: number;
  answers: Record<string, unknown>;
  ended: boolean;
}

export type FlowInput =
  | { kind: 'start' }
  /** A customer message; `replyId` is the id of a tapped button or list row. */
  | { kind: 'message'; text: string | null; replyId: string | null; contentType: string }
  | { kind: 'timer'; token: number }
  | { kind: 'api'; token: number; ok: boolean; mapped: Record<string, unknown> };

export interface RunContext {
  graph: FlowGraph;
  /** Fills variables (`{first_name}`, `{attr:key}`, `{answer:name}`) with the step's fallbacks. */
  render: (text: string, fallbacks: Record<string, string>, answers: Record<string, unknown>) => string;
}

export interface RunResult {
  state: SessionState;
  effects: FlowEffect[];
  /** True when this run ended the session. */
  ended: boolean;
}

export function newSessionState(sessionId: string): SessionState {
  return { sessionId, currentStepId: null, wait: 'NONE', waitToken: 0, retries: 0, stepsSinceInput: 0, answers: {}, ended: false };
}

class Runner {
  readonly effects: FlowEffect[] = [];
  private readonly steps: Map<string, FlowStep>;

  constructor(
    public state: SessionState,
    private readonly ctx: RunContext,
  ) {
    this.steps = new Map(ctx.graph.steps.map((s) => [s.id, s]));
  }

  end(result: FlowSessionResult, reason?: string): RunResult {
    this.effects.push(reason ? { kind: 'end', result, reason } : { kind: 'end', result });
    this.state = { ...this.state, currentStepId: null, wait: 'NONE', ended: true };
    return { state: this.state, effects: this.effects, ended: true };
  }

  idle(): RunResult {
    return { state: this.state, effects: this.effects, ended: false };
  }

  /** Leaves the current step by a branch and moves to its target (null ends the session). */
  leave(step: FlowStep, branch: string, target: string | null): void {
    this.effects.push({ kind: 'stepLeft', stepId: step.id, branch });
    this.state = { ...this.state, currentStepId: target, wait: 'NONE', retries: 0 };
  }

  /** Runs steps from the current one until a wait or the end. */
  advance(): RunResult {
    for (;;) {
      const id = this.state.currentStepId;
      if (id === null) return this.end('COMPLETED');
      const step = this.steps.get(id);
      if (!step) return this.end('FAILED', `step "${id}" does not exist`);
      if (this.state.stepsSinceInput >= MAX_STEPS_WITHOUT_INPUT) return this.end('FAILED', 'too many steps without a customer reply');
      this.state = { ...this.state, stepsSinceInput: this.state.stepsSinceInput + 1 };
      this.effects.push({ kind: 'stepEntered', stepId: step.id });

      switch (step.type) {
        case 'message': {
          const text = step.text.trim() ? this.ctx.render(step.text, step.fallbacks, this.state.answers) : '';
          if (step.mediaAssetId) {
            this.effects.push({ kind: 'send', stepId: step.id, message: text ? { type: 'media', mediaAssetId: step.mediaAssetId, caption: text } : { type: 'media', mediaAssetId: step.mediaAssetId } });
          } else if (text) {
            this.effects.push({ kind: 'send', stepId: step.id, message: { type: 'text', text } });
          }
          this.leave(step, 'next', step.next);
          continue;
        }
        case 'end':
          this.effects.push({ kind: 'stepLeft', stepId: step.id, branch: 'end' });
          return this.end('COMPLETED');
        default:
          return this.end('FAILED', `the "${step.type}" step is not supported yet`);
      }
    }
  }
}

/** Applies one input to a session and runs it as far as it can go. */
export function run(state: SessionState, input: FlowInput, ctx: RunContext): RunResult {
  if (state.ended) return { state, effects: [], ended: false };
  const runner = new Runner(state, ctx);
  switch (input.kind) {
    case 'start': {
      if (!ctx.graph.start) return runner.end('FAILED', 'the flow has no start step');
      runner.state = { ...state, currentStepId: ctx.graph.start, wait: 'NONE', waitToken: state.waitToken + 1, retries: 0, stepsSinceInput: 0 };
      return runner.advance();
    }
    case 'message':
    case 'timer':
    case 'api':
      // Waiting steps (buttons, lists, questions, delays, API calls) arrive with their stories.
      return runner.idle();
  }
}
