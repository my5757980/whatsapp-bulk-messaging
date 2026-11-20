import { opNeedsValue, opsFor } from './conditions.js';
import { branchesOf, type FlowGraph, type FlowStep, type FlowTrigger, type StepType } from './graph.js';
import { isReservedKeyword, unsafePatternReason } from './triggers.js';

// Publish checks (003 FR-003, research R14, T021). Pure; the API adds checks that need the database
// (other flows' keywords, attributes, templates, jump targets) and runs this first. The editor runs it
// for instant feedback.

export type ProblemCode =
  | 'NO_START'
  | 'MISSING_CONTENT'
  | 'BRANCH_NOT_CONNECTED'
  | 'UNREACHABLE_STEP'
  | 'LIMIT_EXCEEDED'
  | 'UNKNOWN_ATTRIBUTE'
  | 'ATTRIBUTE_TYPE'
  | 'DUPLICATE_ANSWER_NAME'
  | 'KEYWORD_TAKEN'
  | 'RESERVED_KEYWORD'
  | 'UNSAFE_PATTERN'
  | 'LOOP_WITHOUT_WAIT'
  | 'JUMP_TARGET_NOT_PUBLISHED'
  | 'NOT_HTTPS';

export interface Problem {
  code: ProblemCode;
  message: string;
  stepId: string | null;
  triggerId: string | null;
  field: string | null;
}

export interface ValidateOptions {
  /** Opt-out, opt-in and "talk to a person" keywords (FR-021). */
  reservedKeywords?: readonly string[];
}

const blank = (value: string | null | undefined) => !value?.trim();

function stepProblem(step: FlowStep, code: ProblemCode, message: string, field: string | null = null): Problem {
  return { code, message, stepId: step.id, triggerId: null, field };
}

function triggerProblem(trigger: FlowTrigger, code: ProblemCode, message: string, field: string | null = null): Problem {
  return { code, message, stepId: null, triggerId: trigger.id, field };
}

function contentProblems(step: FlowStep): Problem[] {
  const missing = (message: string, field: string | null = null) => [stepProblem(step, 'MISSING_CONTENT', message, field)];
  switch (step.type) {
    case 'message':
      return blank(step.text) && !step.mediaAssetId ? missing('Add a text or a media file', 'text') : [];
    case 'buttons':
      if (blank(step.text)) return missing('Add the text shown above the buttons', 'text');
      if (!step.buttons.length) return missing('Add at least one button', 'buttons');
      return step.buttons.some((b) => blank(b.title)) ? missing('Every button needs a title', 'buttons') : [];
    case 'list': {
      const rows = step.sections.flatMap((s) => s.rows);
      if (blank(step.text)) return missing('Add the text shown above the list', 'text');
      if (blank(step.buttonLabel)) return missing('Add the label of the list button', 'buttonLabel');
      if (!rows.length) return missing('Add at least one option', 'sections');
      return rows.some((r) => blank(r.title)) ? missing('Every option needs a title', 'sections') : [];
    }
    case 'question':
      if (blank(step.text)) return missing('Add the question', 'text');
      if (!step.answerName) return missing('Name the answer so it can be used later', 'answerName');
      return step.retries > 0 && blank(step.retryText) ? missing('Add the message sent after a wrong answer', 'retryText') : [];
    case 'tags':
      return !step.add.length && !step.remove.length ? missing('Choose tags to add or remove', 'add') : [];
    case 'attributes':
      return !step.set.length ? missing('Choose at least one attribute to set', 'set') : [];
    case 'condition':
      if (!step.rules.length) return missing('Add at least one rule', 'rules');
      return step.rules.some((r) => !opsFor(r.subject).includes(r.op) || (opNeedsValue(r.op) && blank(r.value)))
        ? missing('Complete every rule: choose a comparison that fits and the value to compare with', 'rules')
        : [];
    case 'api':
      if (blank(step.url)) return missing('Add the address to call', 'url');
      return /^https:\/\//i.test(step.url.trim()) ? [] : [stepProblem(step, 'NOT_HTTPS', 'The address must start with https://', 'url')];
    case 'jump':
      return step.flowId ? [] : missing('Choose the flow to continue in', 'flowId');
    case 'delay':
    case 'handover':
    case 'end':
      return [];
  }
}

function triggerProblems(trigger: FlowTrigger, options: ValidateOptions): Problem[] {
  switch (trigger.kind) {
    case 'KEYWORD':
    case 'FIRST_MESSAGE': {
      const phrases = trigger.phrases.filter((p) => !blank(p));
      if (!phrases.length) return [triggerProblem(trigger, 'MISSING_CONTENT', 'Add at least one keyword or phrase', 'phrases')];
      const reserved = phrases.filter((p) => isReservedKeyword(p, options.reservedKeywords ?? []));
      return reserved.length
        ? [triggerProblem(trigger, 'RESERVED_KEYWORD', `These keywords are reserved for opt-out, opt-in or "talk to a person": ${reserved.map((p) => p.trim().toLowerCase()).join(', ')}`, 'phrases')]
        : [];
    }
    case 'PATTERN': {
      if (blank(trigger.pattern)) return [triggerProblem(trigger, 'MISSING_CONTENT', 'Add the pattern', 'pattern')];
      const unsafe = unsafePatternReason(trigger.pattern);
      return unsafe ? [triggerProblem(trigger, 'UNSAFE_PATTERN', unsafe, 'pattern')] : [];
    }
    case 'TEMPLATE_BUTTON':
      if (!trigger.templateId) return [triggerProblem(trigger, 'MISSING_CONTENT', 'Choose the template', 'templateId')];
      return blank(trigger.buttonText) ? [triggerProblem(trigger, 'MISSING_CONTENT', 'Choose the quick-reply button', 'buttonText')] : [];
  }
}

/** Steps that wait for the customer, so a loop through one of them cannot spin on its own (FR-033). */
const WAITING: ReadonlySet<StepType> = new Set(['question', 'buttons', 'list']);

/** One step of each loop (among the given steps) that never waits for the customer. */
export function loopsWithoutWait(graph: FlowGraph, only?: ReadonlySet<string>): string[] {
  const byId = new Map(graph.steps.filter((s) => !only || only.has(s.id)).map((s) => [s.id, s]));
  const state = new Map<string, 'open' | 'done'>();
  const found = new Set<string>();
  const visit = (id: string): void => {
    state.set(id, 'open');
    const step = byId.get(id);
    if (step && !WAITING.has(step.type)) {
      for (const exit of branchesOf(step)) {
        if (!exit.target || !byId.has(exit.target)) continue;
        const seen = state.get(exit.target);
        if (seen === 'open') found.add(exit.target);
        else if (!seen) visit(exit.target);
      }
    }
    state.set(id, 'done');
  };
  for (const id of byId.keys()) if (!state.has(id)) visit(id);
  return [...found];
}

/** Flows a session jumps to from the start without waiting for the customer (loops across flows). */
export function jumpsWithoutWait(graph: FlowGraph): string[] {
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const targets = new Set<string>();
  const queue = graph.start ? [graph.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const step = byId.get(id);
    if (!step || WAITING.has(step.type)) continue;
    if (step.type === 'jump' && step.flowId) targets.add(step.flowId);
    for (const exit of branchesOf(step)) if (exit.target) queue.push(exit.target);
  }
  return [...targets];
}

/** Steps reachable from the start step by following branches. */
export function reachableSteps(graph: FlowGraph): Set<string> {
  const byId = new Map(graph.steps.map((s) => [s.id, s]));
  const seen = new Set<string>();
  const queue = graph.start ? [graph.start] : [];
  while (queue.length) {
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    const step = byId.get(id);
    if (!step) continue;
    seen.add(id);
    for (const exit of branchesOf(step)) if (exit.target && !seen.has(exit.target)) queue.push(exit.target);
  }
  return seen;
}

export function validateForPublish(graph: FlowGraph, options: ValidateOptions = {}): Problem[] {
  const problems: Problem[] = [];
  if (!graph.start) {
    problems.push({ code: 'NO_START', message: 'Add a first step', stepId: null, triggerId: null, field: 'start' });
    return problems;
  }
  const reachable = reachableSteps(graph);
  // Answer names are unique, so {answer:name} always means one step (T035).
  const answerOwners = new Map<string, string>();
  for (const step of graph.steps) {
    if (!reachable.has(step.id)) {
      problems.push(stepProblem(step, 'UNREACHABLE_STEP', 'No branch leads to this step'));
      continue;
    }
    problems.push(...contentProblems(step));
    const answerName = 'answerName' in step ? step.answerName : undefined;
    if (answerName) {
      const owner = answerOwners.get(answerName);
      if (owner) problems.push(stepProblem(step, 'DUPLICATE_ANSWER_NAME', `The answer name "${answerName}" is already used by step "${owner}"`, 'answerName'));
      else answerOwners.set(answerName, step.id);
    }
    for (const exit of branchesOf(step)) {
      if (exit.required && exit.target === null) problems.push(stepProblem(step, 'BRANCH_NOT_CONNECTED', `Connect the "${exit.branch}" branch to a step`, exit.branch));
    }
  }
  for (const id of loopsWithoutWait(graph, reachable)) {
    problems.push({ code: 'LOOP_WITHOUT_WAIT', message: 'These steps go round in a loop without waiting for the customer; add a question, buttons or a list to the loop', stepId: id, triggerId: null, field: null });
  }
  for (const trigger of graph.triggers) problems.push(...triggerProblems(trigger, options));
  return problems;
}
