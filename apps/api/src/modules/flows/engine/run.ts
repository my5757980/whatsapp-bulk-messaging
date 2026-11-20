import { checkAnswer, normalizePhrase, type AnswerContext, type FlowGraph, type FlowStep, type StepOf } from '@wbm/shared';
import type { FlowEffect, FlowSessionResult } from './effects.js';

// The flow interpreter (003 research R4, T009, T025): pure. Given a session's state, one input and
// the version's graph, it returns the next state and the effects to apply. It runs steps until it
// needs the customer, a timer or an API reply, or the session ends. Later stories add step types
// (US2: questions and lists).

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
  /**
   * Fills variables (`{first_name}`, `{attr:key}`, `{answer:name}`) with the step's fallbacks;
   * `attributes` holds values this run saved, so `{attr:key}` shows them before they are stored.
   */
  render: (text: string, fallbacks: Record<string, string>, answers: Record<string, unknown>, attributes?: Record<string, string | number>) => string;
  /** "Today" in the company time zone and the 001 phone rules, for question answers (FR-009). */
  answers: AnswerContext;
}

export interface RunResult {
  state: SessionState;
  effects: FlowEffect[];
  /** True when this run ended the session. */
  ended: boolean;
  /** True when the input was used by the session (false for stale taps and messages during a delay). */
  consumed: boolean;
}

export function newSessionState(sessionId: string): SessionState {
  return { sessionId, currentStepId: null, wait: 'NONE', waitToken: 0, retries: 0, stepsSinceInput: 0, answers: {}, ended: false };
}

/** Id of a button or list row for the session's current wait (contracts/meta-graph-flows.md). */
export function replyIdFor(state: Pick<SessionState, 'sessionId' | 'waitToken'>, key: string): string {
  return `s:${state.sessionId}:${state.waitToken}:${key}`;
}

/** Splits a reply id; null when it is not one of ours. */
export function parseReplyId(id: string): { sessionId: string; token: number; key: string } | null {
  const match = /^s:([0-9a-f-]{36}):(\d+):([a-z0-9_-]{1,30})$/.exec(id);
  return match ? { sessionId: match[1]!, token: Number(match[2]), key: match[3]! } : null;
}

type ButtonsStep = StepOf<'buttons'>;
type ListStep = StepOf<'list'>;
type QuestionStep = StepOf<'question'>;
type MessageInput = Extract<FlowInput, { kind: 'message' }>;
/** Steps that wait for the customer and have a timeout. */
type WaitingStep = ButtonsStep | ListStep | QuestionStep;

class Runner {
  readonly effects: FlowEffect[] = [];
  consumed = false;
  /** Attribute values saved during this run (shown by `{attr:key}` before they are stored). */
  private readonly saved: Record<string, string | number> = {};
  private readonly steps: Map<string, FlowStep>;

  constructor(
    public state: SessionState,
    private readonly ctx: RunContext,
  ) {
    this.steps = new Map(ctx.graph.steps.map((s) => [s.id, s]));
  }

  step(id: string | null): FlowStep | undefined {
    return id === null ? undefined : this.steps.get(id);
  }

  end(result: FlowSessionResult, reason?: string): RunResult {
    this.effects.push(reason ? { kind: 'end', result, reason } : { kind: 'end', result });
    this.state = { ...this.state, currentStepId: null, wait: 'NONE', ended: true };
    return { state: this.state, effects: this.effects, ended: true, consumed: this.consumed };
  }

  idle(): RunResult {
    return { state: this.state, effects: this.effects, ended: false, consumed: this.consumed };
  }

  /** The customer's input was used: the step counter restarts (FR-033). */
  consume(): void {
    this.consumed = true;
    this.state = { ...this.state, stepsSinceInput: 0 };
  }

  /** Leaves the current step by a branch and moves to its target (null ends the session). */
  leave(step: FlowStep, branch: string, target: string | null): void {
    this.effects.push({ kind: 'stepLeft', stepId: step.id, branch });
    this.state = { ...this.state, currentStepId: target, wait: 'NONE', retries: 0 };
  }

  /** Leaves by an optional branch; ends with `result` when it leads nowhere. */
  leaveOptional(step: FlowStep, branch: string, target: string | null, result: FlowSessionResult, reason?: string): RunResult {
    this.leave(step, branch, target);
    return target === null ? this.end(result, reason) : this.advance();
  }

  render(text: string, fallbacks: Record<string, string>): string {
    return this.ctx.render(text, fallbacks, this.state.answers, this.saved);
  }

  /** Starts waiting for the customer: a new token, so older timers and taps no longer apply. */
  waitForInput(): void {
    this.state = { ...this.state, wait: 'INPUT', waitToken: this.state.waitToken + 1, retries: 0 };
  }

  sendText(step: FlowStep, text: string): void {
    if (text.trim()) this.effects.push({ kind: 'send', stepId: step.id, message: { type: 'text', text } });
  }

  /** The option a message chooses: by reply id ('stale' for older or other sessions' taps) or by typed title. */
  chosen<T extends { key: string; title: string }>(options: T[], input: MessageInput): T | 'stale' | undefined {
    if (input.replyId) {
      const reply = parseReplyId(input.replyId);
      if (!reply || reply.sessionId !== this.state.sessionId || reply.token !== this.state.waitToken) return 'stale';
      return options.find((o) => o.key === reply.key) ?? 'stale';
    }
    if (!input.text?.trim()) return undefined;
    const typed = normalizePhrase(input.text);
    return options.find((o) => normalizePhrase(o.title) === typed);
  }

  scheduleTimeout(step: WaitingStep): void {
    this.effects.push({ kind: 'schedule', stepId: step.id, purpose: 'timeout', delayMs: step.timeoutMinutes * 60_000 });
  }

  /** Records an answer and, when the step saves it, the attribute change. */
  remember(step: { id: string; answerName?: string; saveTo?: { attributeKey: string } }, value: string | number): void {
    if (step.answerName) this.state = { ...this.state, answers: { ...this.state.answers, [step.answerName]: value } };
    if (step.saveTo) {
      this.saved[step.saveTo.attributeKey] = value;
      this.effects.push({ kind: 'setAttributes', stepId: step.id, values: { [step.saveTo.attributeKey]: value } });
    }
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
          const text = step.text.trim() ? this.render(step.text, step.fallbacks) : '';
          if (step.mediaAssetId) {
            this.effects.push({ kind: 'send', stepId: step.id, message: text ? { type: 'media', mediaAssetId: step.mediaAssetId, caption: text } : { type: 'media', mediaAssetId: step.mediaAssetId } });
          } else if (text) {
            this.effects.push({ kind: 'send', stepId: step.id, message: { type: 'text', text } });
          }
          this.leave(step, 'next', step.next);
          continue;
        }
        case 'buttons': {
          this.waitForInput();
          this.effects.push({
            kind: 'send',
            stepId: step.id,
            message: {
              type: 'buttons',
              text: this.render(step.text, step.fallbacks),
              ...(step.header?.trim() ? { header: this.render(step.header, step.fallbacks) } : {}),
              ...(step.footer?.trim() ? { footer: this.render(step.footer, step.fallbacks) } : {}),
              buttons: step.buttons.map((b) => ({ id: replyIdFor(this.state, b.key), title: b.title })),
            },
          });
          this.scheduleTimeout(step);
          return this.idle();
        }
        case 'list': {
          this.waitForInput();
          this.effects.push({
            kind: 'send',
            stepId: step.id,
            message: {
              type: 'list',
              text: this.render(step.text, step.fallbacks),
              ...(step.header?.trim() ? { header: this.render(step.header, step.fallbacks) } : {}),
              ...(step.footer?.trim() ? { footer: this.render(step.footer, step.fallbacks) } : {}),
              buttonLabel: step.buttonLabel,
              sections: step.sections.map((section) => ({
                ...(section.title?.trim() ? { title: section.title } : {}),
                rows: section.rows.map((row) => ({ id: replyIdFor(this.state, row.key), title: row.title, ...(row.description?.trim() ? { description: row.description } : {}) })),
              })),
            },
          });
          this.scheduleTimeout(step);
          return this.idle();
        }
        case 'question':
          this.waitForInput();
          this.sendText(step, this.render(step.text, step.fallbacks));
          this.scheduleTimeout(step);
          return this.idle();
        case 'handover':
          // The chat waits for a person (002 Waiting for agent); the session hands over and ends.
          this.effects.push(step.note?.trim() ? { kind: 'handover', stepId: step.id, note: step.note.trim() } : { kind: 'handover', stepId: step.id });
          this.effects.push({ kind: 'stepLeft', stepId: step.id, branch: 'handover' });
          return this.end('HANDED_OVER');
        case 'end':
          this.effects.push({ kind: 'stepLeft', stepId: step.id, branch: 'end' });
          return this.end('COMPLETED');
        default:
          return this.end('FAILED', `the "${step.type}" step is not supported yet`);
      }
    }
  }

  /** A customer message while waiting at a buttons step. */
  answerButtons(step: ButtonsStep, input: MessageInput): RunResult {
    const choice = this.chosen(step.buttons, input);
    // A tap on an older message, or on another session's buttons, does not move the session.
    if (choice === 'stale') return this.idle();
    this.consume();
    if (!choice) return this.leaveOptional(step, 'onInvalid', step.onInvalid, 'FAILED', 'no valid answer');
    this.remember(step, choice.title);
    this.leave(step, choice.key, choice.next);
    return this.advance();
  }

  /** A customer message while waiting at a list step; every row may share one next step. */
  answerList(step: ListStep, input: MessageInput): RunResult {
    const choice = this.chosen(
      step.sections.flatMap((s) => s.rows),
      input,
    );
    if (choice === 'stale') return this.idle();
    this.consume();
    if (!choice) return this.leaveOptional(step, 'onInvalid', step.onInvalid, 'FAILED', 'no valid answer');
    this.remember(step, choice.title);
    this.leave(step, choice.key, step.sharedNext ?? choice.next);
    return this.advance();
  }

  /**
   * A customer message while waiting at a question (FR-009): a valid answer moves on; a wrong one
   * gets the retry prompt (with a fresh timeout) until the retries run out, then the invalid branch.
   * Only text counts, so a photo is a wrong answer; a tap on an older message is ignored.
   */
  answerQuestion(step: QuestionStep, input: MessageInput): RunResult {
    if (input.replyId) return this.idle();
    const checked = checkAnswer(step.answer, input.contentType === 'TEXT' ? input.text : null, this.ctx.answers);
    this.consume();
    if (checked.ok) {
      this.remember(step, checked.value);
      this.leave(step, 'next', step.next);
      return this.advance();
    }
    if (this.state.retries < step.retries) {
      this.state = { ...this.state, waitToken: this.state.waitToken + 1, retries: this.state.retries + 1 };
      this.sendText(step, this.render(step.retryText.trim() ? step.retryText : step.text, step.fallbacks));
      this.scheduleTimeout(step);
      return this.idle();
    }
    return this.leaveOptional(step, 'onInvalid', step.onInvalid, 'FAILED', 'no valid answer');
  }
}

/** Applies one input to a session and runs it as far as it can go. */
export function run(state: SessionState, input: FlowInput, ctx: RunContext): RunResult {
  if (state.ended) return { state, effects: [], ended: false, consumed: false };
  const runner = new Runner(state, ctx);
  switch (input.kind) {
    case 'start': {
      if (!ctx.graph.start) return runner.end('FAILED', 'the flow has no start step');
      runner.state = { ...state, currentStepId: ctx.graph.start, wait: 'NONE', waitToken: state.waitToken + 1, retries: 0, stepsSinceInput: 0 };
      return runner.advance();
    }
    case 'message': {
      if (state.wait !== 'INPUT') return runner.idle();
      const step = runner.step(state.currentStepId);
      if (step?.type === 'buttons') return runner.answerButtons(step, input);
      if (step?.type === 'list') return runner.answerList(step, input);
      if (step?.type === 'question') return runner.answerQuestion(step, input);
      return runner.idle();
    }
    case 'timer': {
      if (input.token !== state.waitToken) return runner.idle();
      const step = runner.step(state.currentStepId);
      if (!step) return runner.idle();
      if (state.wait === 'INPUT' && (step.type === 'buttons' || step.type === 'list' || step.type === 'question')) {
        return runner.leaveOptional(step, 'onTimeout', step.onTimeout, 'TIMED_OUT');
      }
      return runner.idle();
    }
    case 'api':
      // API steps arrive with US5.
      return runner.idle();
  }
}
