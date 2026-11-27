import { branchesOf, type FlowGraph, type FlowStep, type FlowTrigger, type Problem, type StepType } from '@wbm/shared';

// Chatbot flow editor helpers (feature 003, contracts/flows-api.openapi.yaml, flow-graph.md).

export type FlowStatus = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';

export interface PublishedVersionRef {
  id: string;
  number: number;
  publishedAt: string;
  publishedBy: { id: string; name: string } | null;
}

export interface FlowSummary {
  id: string;
  name: string;
  status: FlowStatus;
  priority: number;
  allNumbers: boolean;
  numberIds: string[];
  testNumbers: string[];
  publishedVersion: PublishedVersionRef | null;
  draftUpdatedAt: string | null;
  hasUnpublishedChanges: boolean;
  triggers: string[];
  last7Days?: { started: number; completed: number };
}

export interface FlowDetail extends Omit<FlowSummary, 'triggers' | 'last7Days'> {
  graph: FlowGraph;
  draftRevision: number;
  problems?: Problem[];
  secrets: Array<{ id: string; name: string; updatedAt: string }>;
}

export const flowKeys = {
  all: ['flows'] as const,
  list: ['flows', 'list'] as const,
  detail: (id: string) => ['flows', 'detail', id] as const,
};

/** Step types the editor offers, in palette order, with our own labels. */
export const STEP_LABELS: Record<StepType, string> = {
  message: 'Message',
  buttons: 'Buttons',
  list: 'List',
  question: 'Question',
  tags: 'Tags',
  attributes: 'Attributes',
  condition: 'Condition',
  delay: 'Delay',
  api: 'API call',
  jump: 'Go to flow',
  handover: 'Hand over',
  aiAgent: 'Hand to AI agent',
  end: 'End',
  payment: 'Request payment',
  product: 'Send products',
  catalog: 'Send catalog',
  form: 'Send form',
};

/** Steps available so far; later stories add the rest (hand-over arrives with US3). */
export const PALETTE: StepType[] = ['message', 'buttons', 'question', 'list', 'tags', 'attributes', 'condition', 'delay', 'api', 'product', 'catalog', 'form', 'payment', 'jump', 'aiAgent', 'end'];

/** A readable name for a branch of a step. */
export function branchLabel(step: FlowStep, branch: string): string {
  if (step.type === 'buttons') {
    const button = step.buttons.find((b) => b.key === branch);
    if (button) return button.title.trim() || 'Untitled button';
  }
  if (step.type === 'list') {
    const row = step.sections.flatMap((s) => s.rows).find((r) => r.key === branch);
    if (row) return row.title.trim() || 'Untitled option';
  }
  const names: Record<string, string> = {
    next: 'Next',
    onTimeout: 'No answer',
    onInvalid: 'Other answer',
    sharedNext: 'Any option',
    yes: 'Yes',
    no: 'No',
    success: 'Success',
    failed: 'Failed',
    onNotPaid: 'Not paid',
  };
  return names[branch] ?? branch;
}

/** A short summary of a step for its box on the canvas. */
export function stepSummary(step: FlowStep): string {
  switch (step.type) {
    case 'message':
      return step.text.trim() || (step.mediaAssetId ? 'Media file' : 'Empty message');
    case 'buttons':
    case 'list':
    case 'question':
      return step.text.trim() || 'No text yet';
    case 'tags': {
      const parts = [step.add.length ? `add ${step.add.length} tag${step.add.length === 1 ? '' : 's'}` : '', step.remove.length ? `remove ${step.remove.length}` : ''].filter(Boolean);
      return parts.length ? parts.join(' · ').replace(/^./, (c) => c.toUpperCase()) : 'No tags chosen';
    }
    case 'attributes':
      return step.set.length ? `Set ${step.set.length} attribute${step.set.length === 1 ? '' : 's'}` : 'No attributes chosen';
    case 'condition':
      return step.rules.length ? `${step.rules.length} rule${step.rules.length === 1 ? '' : 's'}: ${step.join === 'all' ? 'all must match' : 'any may match'}` : 'No rules yet';
    case 'delay':
      return `Wait ${durationText(step.seconds)}`;
    case 'jump':
      return step.flowId ? 'Continue in another flow' : 'No flow chosen';
    case 'api': {
      const host = /^https:\/\/([^/?#]+)/i.exec(step.url.trim())?.[1];
      return host ? `${step.method} ${host}` : 'No address yet';
    }
    case 'handover':
      return 'The chat waits for a person in live chat';
    case 'aiAgent':
      return step.agentId ? 'An AI agent answers from here' : 'No agent chosen';
    case 'end':
      return 'The flow ends';
    case 'payment': {
      const amount =
        step.amount.source === 'static'
          ? `AED ${(step.amount.minor / 100).toFixed(2)}`
          : step.amount.source === 'answer'
            ? `the ${step.amount.name} answer`
            : step.amount.source === 'cartTotal'
              ? 'the cart total'
              : `the ${step.amount.key} attribute`;
      return `Ask for ${amount}${step.description.trim() ? `: ${step.description.trim()}` : ''}`;
    }
    case 'product': {
      const count = step.sections.flatMap((s) => s.retailerIds).length;
      return count ? `Send ${count} product${count === 1 ? '' : 's'} and wait for a cart` : 'No products chosen';
    }
    case 'catalog':
      return 'Send the catalog and wait for a cart';
    case 'form':
      return step.formId ? 'Send a form and wait for the answer' : 'No form chosen';
  }
}

/** 90 -> "90 seconds", 300 -> "5 minutes", 7200 -> "2 hours". */
export function durationText(seconds: number): string {
  const [n, unit] = seconds % 3600 === 0 ? [seconds / 3600, 'hour'] : seconds % 60 === 0 ? [seconds / 60, 'minute'] : [seconds, 'second'];
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
}

/** Answer names the flow's steps set, for attribute and condition steps that read answers. */
export function answerNamesIn(graph: FlowGraph): string[] {
  const names = graph.steps.flatMap((s) => {
    if (s.type === 'api') return s.map.map((m) => m.answerName);
    return 'answerName' in s && s.answerName ? [s.answerName] : [];
  });
  return [...new Set(names)];
}

export function nextStepId(graph: FlowGraph, type: StepType): string {
  const used = new Set(graph.steps.map((s) => s.id));
  // Step ids use lower-case letters only ("aiAgent" steps become "ai-agent-1").
  const prefix = type.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  for (let n = 1; ; n++) if (!used.has(`${prefix}-${n}`)) return `${prefix}-${n}`;
}

export function newStep(type: StepType, id: string, position: { x: number; y: number }): FlowStep {
  switch (type) {
    case 'message':
      return { id, type, position, text: '', mediaAssetId: null, fallbacks: {}, next: null };
    case 'buttons':
      return { id, type, position, text: '', buttons: [{ key: 'b1', title: 'Option 1', next: null }], timeoutMinutes: 60, onTimeout: null, onInvalid: null, fallbacks: {} };
    case 'question':
      return { id, type, position, text: '', answer: { kind: 'text' }, retries: 2, retryText: '', timeoutMinutes: 60, next: null, onInvalid: null, onTimeout: null, fallbacks: {} };
    case 'list':
      return {
        id,
        type,
        position,
        text: '',
        buttonLabel: 'Choose',
        sections: [{ rows: [{ key: 'r1', title: 'Option 1', next: null }] }],
        sharedNext: null,
        timeoutMinutes: 60,
        onTimeout: null,
        onInvalid: null,
        fallbacks: {},
      };
    case 'tags':
      return { id, type, position, add: [], remove: [], next: null };
    case 'attributes':
      return { id, type, position, set: [], next: null };
    case 'condition':
      return { id, type, position, join: 'all', rules: [{ subject: { kind: 'workingHours' }, op: 'inside' }], yes: null, no: null };
    case 'delay':
      return { id, type, position, seconds: 60, next: null };
    case 'jump':
      return { id, type, position, flowId: null };
    case 'api':
      return { id, type, position, method: 'GET', url: '', headers: [], query: [], timeoutSeconds: 5, map: [], success: null, failed: null };
    case 'handover':
      return { id, type, position };
    case 'aiAgent':
      return { id, type, position, agentId: null };
    case 'end':
      return { id, type, position };
    case 'payment':
      return { id, type, position, amount: { source: 'static', minor: 10_000 }, description: '', expiryMinutes: 60, next: null, onNotPaid: null, fallbacks: {} };
    case 'product':
      return { id, type, position, header: '', body: '', footer: '', sections: [{ title: '', retailerIds: [] as unknown as [string] }], timeoutMinutes: 60, next: null, onTimeout: null, fallbacks: {} };
    case 'catalog':
      return { id, type, position, body: '', footer: '', thumbnailRetailerId: null, timeoutMinutes: 60, next: null, onTimeout: null, fallbacks: {} };
    case 'form':
      return { id, type, position, formId: null, header: '', body: '', cta: 'Open form', answerPrefix: 'form', timeoutMinutes: 60, next: null, onTimeout: null, fallbacks: {} };
    default:
      throw new Error(`The ${type} step is not available yet`);
  }
}

/** The step with one branch pointing somewhere else (null ends the flow there). */
export function withBranch(step: FlowStep, branch: string, target: string | null): FlowStep {
  switch (step.type) {
    case 'message':
    case 'tags':
    case 'attributes':
    case 'delay':
      return branch === 'next' ? { ...step, next: target } : step;
    case 'question':
      if (branch === 'next' || branch === 'onInvalid' || branch === 'onTimeout') return { ...step, [branch]: target };
      return step;
    case 'buttons':
      if (branch === 'onInvalid' || branch === 'onTimeout') return { ...step, [branch]: target };
      return { ...step, buttons: step.buttons.map((b) => (b.key === branch ? { ...b, next: target } : b)) };
    case 'list':
      if (branch === 'onInvalid' || branch === 'onTimeout' || branch === 'sharedNext') return { ...step, [branch]: target };
      return { ...step, sections: step.sections.map((s) => ({ ...s, rows: s.rows.map((r) => (r.key === branch ? { ...r, next: target } : r)) })) };
    case 'condition':
      return branch === 'yes' || branch === 'no' ? { ...step, [branch]: target } : step;
    case 'api':
      return branch === 'success' || branch === 'failed' ? { ...step, [branch]: target } : step;
    case 'payment':
      return branch === 'next' || branch === 'onNotPaid' ? { ...step, [branch]: target } : step;
    case 'product':
    case 'catalog':
    case 'form':
      return branch === 'next' || branch === 'onTimeout' ? { ...step, [branch]: target } : step;
    default:
      return step;
  }
}

export function updateStep(graph: FlowGraph, id: string, change: (step: FlowStep) => FlowStep): FlowGraph {
  return { ...graph, steps: graph.steps.map((s) => (s.id === id ? change(s) : s)) };
}

export function setBranch(graph: FlowGraph, stepId: string, branch: string, target: string | null): FlowGraph {
  return updateStep(graph, stepId, (s) => withBranch(s, branch, target));
}

/** Removes a step and every branch that led to it. */
export function removeStep(graph: FlowGraph, id: string): FlowGraph {
  const steps = graph.steps
    .filter((s) => s.id !== id)
    .map((s) => branchesOf(s).reduce((acc, exit) => (exit.target === id ? withBranch(acc, exit.branch, null) : acc), s));
  return { ...graph, start: graph.start === id ? null : graph.start, steps };
}

/** Answer names in use, so new and copied steps get their own (publish refuses duplicates). */
function answerNames(graph: FlowGraph): Set<string> {
  return new Set(graph.steps.flatMap((s) => ('answerName' in s && s.answerName ? [s.answerName] : [])));
}

/** The first free answer name: `base`, then base_2, base_3, ... */
export function uniqueAnswerName(graph: FlowGraph, base: string): string {
  const used = answerNames(graph);
  if (!used.has(base)) return base;
  const stem = base.slice(0, 36);
  for (let n = 2; ; n++) if (!used.has(`${stem}_${n}`)) return `${stem}_${n}`;
}

export function addStep(graph: FlowGraph, type: StepType, position: { x: number; y: number }): { graph: FlowGraph; id: string } {
  const id = nextStepId(graph, type);
  let step = newStep(type, id, position);
  // A question needs an answer name to be published; start with a free one.
  if (step.type === 'question') step = { ...step, answerName: uniqueAnswerName(graph, 'answer') };
  return { id, graph: { ...graph, start: graph.start ?? id, steps: [...graph.steps, step] } };
}

/** A copy of a step (copy and paste, Duplicate): a new id, moved a little, links to missing steps dropped. */
export function pasteStep(graph: FlowGraph, source: FlowStep): { graph: FlowGraph; id: string } {
  const id = nextStepId(graph, source.type);
  const ids = new Set(graph.steps.map((s) => s.id));
  let copy = { ...structuredClone(source), id, position: { x: source.position.x + 40, y: source.position.y + 40 } } as FlowStep;
  for (const exit of branchesOf(copy)) if (exit.target !== null && !ids.has(exit.target)) copy = withBranch(copy, exit.branch, null);
  if ('answerName' in copy && copy.answerName) copy = { ...copy, answerName: uniqueAnswerName(graph, copy.answerName) };
  return { id, graph: { ...graph, steps: [...graph.steps, copy] } };
}

/** The first free option key (b1, b2, ...) for a new button or list row. */
export function nextOptionKey(keys: string[], prefix = 'b'): string {
  const used = new Set(keys);
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

/** A new trigger of a kind with the first free id (keyword-1, pattern-1, button-1, first-1). */
export function newTrigger(graph: FlowGraph, kind: FlowTrigger['kind']): FlowTrigger {
  const prefix = { KEYWORD: 'keyword', PATTERN: 'pattern', TEMPLATE_BUTTON: 'button', FIRST_MESSAGE: 'first' }[kind];
  const used = new Set(graph.triggers.map((t) => t.id));
  let n = 1;
  while (used.has(`${prefix}-${n}`)) n++;
  const id = `${prefix}-${n}`;
  switch (kind) {
    case 'KEYWORD':
      return { id, kind, match: 'CONTAINS', phrases: [], canInterrupt: false };
    case 'PATTERN':
      return { id, kind, pattern: '', canInterrupt: false };
    case 'TEMPLATE_BUTTON':
      return { id, kind, templateId: null, buttonText: '', canInterrupt: false };
    case 'FIRST_MESSAGE':
      return { id, kind, match: 'CONTAINS', phrases: [], tagId: null, startFlow: true };
  }
}

export function newKeywordTrigger(graph: FlowGraph): FlowTrigger {
  const used = new Set(graph.triggers.map((t) => t.id));
  let n = 1;
  while (used.has(`keyword-${n}`)) n++;
  return { id: `keyword-${n}`, kind: 'KEYWORD', match: 'CONTAINS', phrases: [], canInterrupt: false };
}

/** Problems that belong to a step, for its badge on the canvas. */
export function problemsByStep(problems: Problem[] | undefined): Map<string, Problem[]> {
  const map = new Map<string, Problem[]>();
  for (const problem of problems ?? []) {
    if (!problem.stepId) continue;
    map.set(problem.stepId, [...(map.get(problem.stepId) ?? []), problem]);
  }
  return map;
}
