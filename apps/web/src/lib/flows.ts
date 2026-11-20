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
  end: 'End',
};

/** Steps available so far; later stories add the rest. */
export const PALETTE: StepType[] = ['message', 'buttons', 'handover', 'end'];

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
    case 'handover':
      return 'The chat waits for a person in live chat';
    case 'end':
      return 'The flow ends';
    default:
      return STEP_LABELS[step.type];
  }
}

export function nextStepId(graph: FlowGraph, type: StepType): string {
  const used = new Set(graph.steps.map((s) => s.id));
  for (let n = 1; ; n++) if (!used.has(`${type}-${n}`)) return `${type}-${n}`;
}

export function newStep(type: StepType, id: string, position: { x: number; y: number }): FlowStep {
  switch (type) {
    case 'message':
      return { id, type, position, text: '', mediaAssetId: null, fallbacks: {}, next: null };
    case 'buttons':
      return { id, type, position, text: '', buttons: [{ key: 'b1', title: 'Option 1', next: null }], timeoutMinutes: 60, onTimeout: null, onInvalid: null, fallbacks: {} };
    case 'handover':
      return { id, type, position };
    case 'end':
      return { id, type, position };
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

export function addStep(graph: FlowGraph, type: StepType, position: { x: number; y: number }): { graph: FlowGraph; id: string } {
  const id = nextStepId(graph, type);
  return { id, graph: { ...graph, start: graph.start ?? id, steps: [...graph.steps, newStep(type, id, position)] } };
}

/** A copy of a step (copy and paste, Duplicate): a new id, moved a little, links to missing steps dropped. */
export function pasteStep(graph: FlowGraph, source: FlowStep): { graph: FlowGraph; id: string } {
  const id = nextStepId(graph, source.type);
  const ids = new Set(graph.steps.map((s) => s.id));
  let copy = { ...structuredClone(source), id, position: { x: source.position.x + 40, y: source.position.y + 40 } } as FlowStep;
  for (const exit of branchesOf(copy)) if (exit.target !== null && !ids.has(exit.target)) copy = withBranch(copy, exit.branch, null);
  return { id, graph: { ...graph, steps: [...graph.steps, copy] } };
}

/** The first free option key (b1, b2, ...) for a new button or list row. */
export function nextOptionKey(keys: string[], prefix = 'b'): string {
  const used = new Set(keys);
  for (let n = 1; ; n++) if (!used.has(`${prefix}${n}`)) return `${prefix}${n}`;
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
