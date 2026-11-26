import { z } from 'zod';

// Flow graph document, version 1 (specs/003-chatbot-flow-builder/contracts/flow-graph.md, T007).
// The schema checks structure and limits only, so an unfinished draft can always be saved; required
// content (texts, buttons, connected branches) is a publish check in validate.ts.

/** WhatsApp and product limits (WhatsApp values: research R7; confirm against Meta before release). */
export const FLOW_LIMITS = {
  steps: 200,
  triggers: 20,
  phrases: 20,
  phraseLength: 200,
  patternLength: 200,
  buttons: 3,
  buttonTitle: 20,
  interactiveBody: 1024,
  headerFooter: 60,
  listSections: 10,
  listRows: 10,
  rowTitle: 24,
  rowDescription: 72,
  sectionTitle: 24,
  listButtonLabel: 20,
  messageText: 4096,
  questionText: 4096,
  retryText: 1024,
  retriesMax: 5,
  timeoutMinutesMin: 1,
  timeoutMinutesMax: 1380,
  delaySecondsMin: 5,
  delaySecondsMax: 82_800,
  apiTimeoutMin: 1,
  apiTimeoutMax: 10,
  apiHeaders: 20,
  apiQuery: 20,
  apiMap: 20,
  apiBodyLength: 8192,
  attributesSet: 20,
  conditionRules: 10,
  tagsPerStep: 20,
  label: 60,
  handoverNote: 500,
  /** Opening message of a Hand to AI agent step (004 FR-033); WhatsApp's caption limit. */
  aiOpeningMessage: 1024,
  /** Feature 008: what a payment step asks for (Stripe's product name limit). */
  paymentDescription: 250,
  paymentExpiryMinutesMin: 30,
  templateButtonText: 25,
  textMaxLength: 1000,
} as const;

const stepId = z.string().regex(/^[a-z0-9_-]{1,40}$/, 'use 1–40 lower-case letters, digits, - or _');
const optionKey = z.string().regex(/^[a-z0-9_-]{1,30}$/, 'use 1–30 lower-case letters, digits, - or _');
/** Where a branch leads: a step id, or null to end the session there. */
const branch = stepId.nullable().default(null);
export const AnswerNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'start with a letter; use lower-case letters, digits and _');
const position = z.strictObject({ x: z.number(), y: z.number() }).default({ x: 0, y: 0 });
const fallbacks = z.record(z.string().max(60), z.string().max(200)).default({});
const timeoutMinutes = z.int().min(FLOW_LIMITS.timeoutMinutesMin).max(FLOW_LIMITS.timeoutMinutesMax).default(60);
const saveTo = z.strictObject({ attributeKey: z.string().min(1).max(60) });
const common = { id: stepId, position, label: z.string().max(FLOW_LIMITS.label).optional() };

const MessageStep = z.strictObject({
  ...common,
  type: z.literal('message'),
  text: z.string().max(FLOW_LIMITS.messageText).default(''),
  mediaAssetId: z.uuid().nullable().default(null),
  fallbacks,
  next: branch,
});

const ButtonsStep = z.strictObject({
  ...common,
  type: z.literal('buttons'),
  text: z.string().max(FLOW_LIMITS.interactiveBody).default(''),
  header: z.string().max(FLOW_LIMITS.headerFooter).optional(),
  footer: z.string().max(FLOW_LIMITS.headerFooter).optional(),
  buttons: z
    .array(z.strictObject({ key: optionKey, title: z.string().max(FLOW_LIMITS.buttonTitle), next: branch }))
    .max(FLOW_LIMITS.buttons)
    .default([]),
  answerName: AnswerNameSchema.optional(),
  saveTo: saveTo.optional(),
  timeoutMinutes,
  onTimeout: branch,
  onInvalid: branch,
  fallbacks,
});

const ListStep = z.strictObject({
  ...common,
  type: z.literal('list'),
  text: z.string().max(FLOW_LIMITS.interactiveBody).default(''),
  header: z.string().max(FLOW_LIMITS.headerFooter).optional(),
  footer: z.string().max(FLOW_LIMITS.headerFooter).optional(),
  buttonLabel: z.string().max(FLOW_LIMITS.listButtonLabel).default(''),
  sections: z
    .array(
      z.strictObject({
        title: z.string().max(FLOW_LIMITS.sectionTitle).optional(),
        rows: z
          .array(
            z.strictObject({
              key: optionKey,
              title: z.string().max(FLOW_LIMITS.rowTitle),
              description: z.string().max(FLOW_LIMITS.rowDescription).optional(),
              next: branch,
            }),
          )
          .max(FLOW_LIMITS.listRows),
      }),
    )
    .max(FLOW_LIMITS.listSections)
    .default([]),
  /** When set, every row continues here instead of its own branch. */
  sharedNext: branch,
  answerName: AnswerNameSchema.optional(),
  saveTo: saveTo.optional(),
  timeoutMinutes,
  onTimeout: branch,
  onInvalid: branch,
  fallbacks,
});

const DateBound = z.union([z.enum(['today', 'tomorrow']), z.iso.date()]);
export const AnswerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('text'), minLength: z.int().min(0).max(FLOW_LIMITS.textMaxLength).optional(), maxLength: z.int().min(1).max(FLOW_LIMITS.textMaxLength).optional() }),
  z.strictObject({ kind: z.literal('number'), min: z.number().optional(), max: z.number().optional(), integer: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('email') }),
  z.strictObject({ kind: z.literal('phone') }),
  z.strictObject({ kind: z.literal('date'), earliest: DateBound.optional(), latest: DateBound.optional() }),
]);
export type AnswerSpec = z.infer<typeof AnswerSchema>;

const QuestionStep = z.strictObject({
  ...common,
  type: z.literal('question'),
  text: z.string().max(FLOW_LIMITS.questionText).default(''),
  answer: AnswerSchema.default({ kind: 'text' }),
  answerName: AnswerNameSchema.optional(),
  saveTo: saveTo.optional(),
  retries: z.int().min(0).max(FLOW_LIMITS.retriesMax).default(2),
  retryText: z.string().max(FLOW_LIMITS.retryText).default(''),
  timeoutMinutes,
  next: branch,
  onInvalid: branch,
  onTimeout: branch,
  fallbacks,
});

const TagsStep = z.strictObject({
  ...common,
  type: z.literal('tags'),
  add: z.array(z.uuid()).max(FLOW_LIMITS.tagsPerStep).default([]),
  remove: z.array(z.uuid()).max(FLOW_LIMITS.tagsPerStep).default([]),
  next: branch,
});

export const ValueSourceSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('static'), value: z.string().max(FLOW_LIMITS.textMaxLength) }),
  z.strictObject({ source: z.literal('answer'), name: AnswerNameSchema }),
  z.strictObject({ source: z.literal('field'), key: z.enum(['name', 'phone']) }),
]);

const AttributesStep = z.strictObject({
  ...common,
  type: z.literal('attributes'),
  set: z
    .array(z.strictObject({ key: z.string().min(1).max(60), value: ValueSourceSchema.nullable() }))
    .max(FLOW_LIMITS.attributesSet)
    .default([]),
  next: branch,
});

export const CONDITION_OPS = [
  'equals',
  'not_equals',
  'contains',
  'starts_with',
  'is_empty',
  'is_not_empty',
  'greater_than',
  'less_than',
  'before',
  'after',
  'is_present',
  'is_absent',
  'inside',
  'outside',
] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];

export const ConditionSubjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('attribute'), key: z.string().min(1).max(60) }),
  z.strictObject({ kind: z.literal('answer'), name: AnswerNameSchema }),
  z.strictObject({ kind: z.literal('field'), key: z.enum(['name', 'phone']) }),
  z.strictObject({ kind: z.literal('tag'), tagId: z.uuid() }),
  z.strictObject({ kind: z.literal('consent') }),
  z.strictObject({ kind: z.literal('workingHours') }),
]);
export const ConditionRuleSchema = z.strictObject({ subject: ConditionSubjectSchema, op: z.enum(CONDITION_OPS), value: z.string().max(200).optional() });
export type ConditionRule = z.infer<typeof ConditionRuleSchema>;

const ConditionStep = z.strictObject({
  ...common,
  type: z.literal('condition'),
  join: z.enum(['all', 'any']).default('all'),
  rules: z.array(ConditionRuleSchema).max(FLOW_LIMITS.conditionRules).default([]),
  yes: branch,
  no: branch,
});

const DelayStep = z.strictObject({
  ...common,
  type: z.literal('delay'),
  seconds: z.int().min(FLOW_LIMITS.delaySecondsMin).max(FLOW_LIMITS.delaySecondsMax).default(60),
  next: branch,
});

const NameValue = z.strictObject({ name: z.string().min(1).max(100), value: z.string().max(2000) });
const ApiStep = z.strictObject({
  ...common,
  type: z.literal('api'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  url: z.string().max(2048).default(''),
  headers: z.array(NameValue).max(FLOW_LIMITS.apiHeaders).default([]),
  query: z.array(NameValue).max(FLOW_LIMITS.apiQuery).default([]),
  body: z.string().max(FLOW_LIMITS.apiBodyLength).optional(),
  timeoutSeconds: z.int().min(FLOW_LIMITS.apiTimeoutMin).max(FLOW_LIMITS.apiTimeoutMax).default(5),
  map: z.array(z.strictObject({ path: z.string().min(1).max(200), answerName: AnswerNameSchema })).max(FLOW_LIMITS.apiMap).default([]),
  success: branch,
  failed: branch,
});

const JumpStep = z.strictObject({ ...common, type: z.literal('jump'), flowId: z.uuid().nullable().default(null) });
const HandoverStep = z.strictObject({ ...common, type: z.literal('handover'), note: z.string().max(FLOW_LIMITS.handoverNote).optional() });
/** Hand to AI agent (004 FR-033): ends the flow and lets the chosen agent answer the chat. */
const AiAgentStep = z.strictObject({
  ...common,
  type: z.literal('aiAgent'),
  agentId: z.uuid().nullable().default(null),
  openingMessage: z.string().max(FLOW_LIMITS.aiOpeningMessage).optional(),
});
const EndStep = z.strictObject({ ...common, type: z.literal('end') });

/**
 * Feature 008 (research R13): ask for a payment and wait. The amount is fixed (minor units), an answer
 * or a contact attribute (major units, e.g. a quote saved earlier); paid goes to `next`, an expired or
 * cancelled request to `onNotPaid`. The request expires within the 24-hour window.
 */
export const PaymentAmountSchema = z.discriminatedUnion('source', [
  z.strictObject({ source: z.literal('static'), minor: z.int().min(1).max(10_000_000_000) }),
  z.strictObject({ source: z.literal('answer'), name: AnswerNameSchema }),
  z.strictObject({ source: z.literal('attribute'), key: z.string().min(1).max(60) }),
]);
export type PaymentAmountSpec = z.infer<typeof PaymentAmountSchema>;
const PaymentStep = z.strictObject({
  ...common,
  type: z.literal('payment'),
  amount: PaymentAmountSchema.default({ source: 'static', minor: 10_000 }),
  description: z.string().max(FLOW_LIMITS.paymentDescription).default(''),
  expiryMinutes: z.int().min(FLOW_LIMITS.paymentExpiryMinutesMin).max(FLOW_LIMITS.timeoutMinutesMax).default(60),
  next: branch,
  onNotPaid: branch,
  fallbacks,
});

export const FlowStepSchema = z.discriminatedUnion('type', [
  MessageStep,
  ButtonsStep,
  ListStep,
  QuestionStep,
  TagsStep,
  AttributesStep,
  ConditionStep,
  DelayStep,
  ApiStep,
  JumpStep,
  HandoverStep,
  AiAgentStep,
  EndStep,
  PaymentStep,
]);
export type FlowStep = z.infer<typeof FlowStepSchema>;
export type StepType = FlowStep['type'];
export type StepOf<T extends StepType> = Extract<FlowStep, { type: T }>;
export const STEP_TYPES: readonly StepType[] = ['message', 'buttons', 'list', 'question', 'tags', 'attributes', 'condition', 'delay', 'api', 'jump', 'handover', 'aiAgent', 'end', 'payment'];

const phrases = z.array(z.string().max(FLOW_LIMITS.phraseLength)).max(FLOW_LIMITS.phrases).default([]);
const match = z.enum(['EXACT', 'CONTAINS']).default('CONTAINS');
const canInterrupt = z.boolean().default(false);
export const FlowTriggerSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: stepId, kind: z.literal('KEYWORD'), match, phrases, canInterrupt }),
  z.strictObject({ id: stepId, kind: z.literal('PATTERN'), pattern: z.string().max(FLOW_LIMITS.patternLength).default(''), answerName: AnswerNameSchema.optional(), canInterrupt }),
  z.strictObject({
    id: stepId,
    kind: z.literal('TEMPLATE_BUTTON'),
    templateId: z.uuid().nullable().default(null),
    buttonText: z.string().max(FLOW_LIMITS.templateButtonText).default(''),
    canInterrupt,
  }),
  z.strictObject({ id: stepId, kind: z.literal('FIRST_MESSAGE'), match, phrases, tagId: z.uuid().nullable().default(null), startFlow: z.boolean().default(true) }),
]);
export type FlowTrigger = z.infer<typeof FlowTriggerSchema>;

export interface Branch {
  /** `next`, `yes`, `no`, `success`, `failed`, `onTimeout`, `onInvalid`, `sharedNext`, or an option key. */
  branch: string;
  target: string | null;
  /** Must lead somewhere before publishing. */
  required: boolean;
}

/** The exits of a step, in display order. */
export function branchesOf(step: FlowStep): Branch[] {
  switch (step.type) {
    case 'message':
    case 'tags':
    case 'attributes':
    case 'delay':
      return [{ branch: 'next', target: step.next, required: false }];
    case 'buttons':
      return [
        ...step.buttons.map((b) => ({ branch: b.key, target: b.next, required: true })),
        { branch: 'onTimeout', target: step.onTimeout, required: false },
        { branch: 'onInvalid', target: step.onInvalid, required: false },
      ];
    case 'list': {
      const shared = step.sharedNext !== null;
      return [
        ...step.sections.flatMap((s) => s.rows).map((r) => ({ branch: r.key, target: shared ? null : r.next, required: !shared })),
        { branch: 'sharedNext', target: step.sharedNext, required: false },
        { branch: 'onTimeout', target: step.onTimeout, required: false },
        { branch: 'onInvalid', target: step.onInvalid, required: false },
      ];
    }
    case 'question':
      return [
        { branch: 'next', target: step.next, required: true },
        { branch: 'onInvalid', target: step.onInvalid, required: false },
        { branch: 'onTimeout', target: step.onTimeout, required: false },
      ];
    case 'condition':
      return [
        { branch: 'yes', target: step.yes, required: true },
        { branch: 'no', target: step.no, required: true },
      ];
    case 'api':
      return [
        { branch: 'success', target: step.success, required: true },
        { branch: 'failed', target: step.failed, required: true },
      ];
    case 'payment':
      return [
        { branch: 'next', target: step.next, required: true },
        { branch: 'onNotPaid', target: step.onNotPaid, required: false },
      ];
    case 'jump':
    case 'handover':
    case 'aiAgent':
    case 'end':
      return [];
  }
}

/** Option keys of a buttons or list step (also used in reply ids). */
export function optionKeysOf(step: FlowStep): string[] {
  if (step.type === 'buttons') return step.buttons.map((b) => b.key);
  if (step.type === 'list') return step.sections.flatMap((s) => s.rows).map((r) => r.key);
  return [];
}

export const FlowGraphSchema = z
  .strictObject({
    version: z.literal(1),
    start: stepId.nullable().default(null),
    triggers: z.array(FlowTriggerSchema).max(FLOW_LIMITS.triggers).default([]),
    steps: z.array(FlowStepSchema).max(FLOW_LIMITS.steps).default([]),
  })
  .superRefine((graph, ctx) => {
    const ids = new Set<string>();
    graph.steps.forEach((step, i) => {
      if (ids.has(step.id)) ctx.addIssue({ code: 'custom', path: ['steps', i, 'id'], message: `step id "${step.id}" is used twice` });
      ids.add(step.id);
    });
    const triggerIds = new Set<string>();
    graph.triggers.forEach((trigger, i) => {
      if (triggerIds.has(trigger.id)) ctx.addIssue({ code: 'custom', path: ['triggers', i, 'id'], message: `trigger id "${trigger.id}" is used twice` });
      triggerIds.add(trigger.id);
    });
    if (graph.start !== null && !ids.has(graph.start)) ctx.addIssue({ code: 'custom', path: ['start'], message: `start step "${graph.start}" does not exist` });
    graph.steps.forEach((step, i) => {
      const keys = optionKeysOf(step);
      if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', path: ['steps', i], message: 'option keys must be unique within a step' });
      if (step.type === 'list' && step.sections.reduce((n, s) => n + s.rows.length, 0) > FLOW_LIMITS.listRows) {
        ctx.addIssue({ code: 'custom', path: ['steps', i, 'sections'], message: `a list has at most ${FLOW_LIMITS.listRows} rows in total` });
      }
      for (const exit of branchesOf(step)) {
        if (exit.target !== null && !ids.has(exit.target)) ctx.addIssue({ code: 'custom', path: ['steps', i], message: `branch "${exit.branch}" leads to a step that does not exist ("${exit.target}")` });
      }
    });
  });
export type FlowGraph = z.infer<typeof FlowGraphSchema>;

export function emptyGraph(): FlowGraph {
  return { version: 1, start: null, triggers: [], steps: [] };
}
