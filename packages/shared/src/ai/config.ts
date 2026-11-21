import { z } from 'zod';

// Agent configuration document, version 1 (specs/004-ai-agent/contracts/agent-config.md, T009).
// The schema checks structure and limits only, so an unfinished draft can always be saved; what
// blocks publishing is reported by agentConfigProblems() here and by the server's own checks.

/** Product limits for agents, knowledge and turns (spec FR-005–FR-046, research R4–R13). */
export const AI_LIMITS = {
  name: 80,
  displayName: 40,
  businessDetails: 4000,
  goal: 1000,
  toneNotes: 300,
  guardrails: 20,
  guardrailLength: 200,
  replyLanguages: 10,
  intro: 200,
  maxReplyCharsMin: 100,
  maxReplyCharsMax: 1000,
  /** WhatsApp caption limit when a reply carries a media file. */
  mediaCaption: 1024,
  handOverTopics: 20,
  topicLength: 100,
  replyCapMin: 5,
  replyCapMax: 100,
  fallbackMessage: 500,
  media: 20,
  memory: 20,
  skillDescription: 300,
  apiSkills: 10,
  apiSkillName: 60,
  whenToUse: 500,
  apiInputs: 5,
  inputDescription: 200,
  inputValue: 200,
  apiHeaders: 20,
  apiQuery: 20,
  apiBodyLength: 8192,
  apiTimeoutMin: 1,
  apiTimeoutMax: 10,
  apiMap: 20,
  flowSkills: 10,
  testNumbers: 3,
  answers: 500,
  questionLength: 300,
  answerLength: 2000,
  websites: 5,
  pagesPerSite: 100,
  files: 50,
  fileBytes: 20 * 1024 * 1024,
  filePages: 300,
  /** Up to this many characters of knowledge go into the cached prompt whole (research R4). */
  wholeKnowledgeChars: 120_000,
  /** Written answers kept in the prompt in search mode. */
  searchModeAnswerChars: 40_000,
  retrievedChunks: 6,
  searchCallsPerTurn: 3,
  historyMessages: 20,
  toolIterations: 4,
  turnDeadlineMs: 30_000,
  debounceMs: 2000,
  previewsPerMinute: 20,
  assistantPrompt: 2000,
} as const;

export const TONE_PRESETS = ['friendly', 'professional', 'warm', 'concise', 'formal'] as const;
export type TonePreset = (typeof TONE_PRESETS)[number];

/** BCP 47 primary language tags such as `en`, `ar`, `ur`, `hi`. */
export const LanguageCodeSchema = z.string().regex(/^[a-z]{2,3}$/, 'use a language code such as en or ar');
const skillId = z.string().regex(/^[a-z][a-z0-9_]{1,39}$/, 'start with a letter; use lower-case letters, digits and _');
const fieldName = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, 'start with a letter; use lower-case letters, digits and _');
const NameValue = z.strictObject({ name: z.string().min(1).max(100), value: z.string().max(2000) });

/** Our default introductions; `{name}` becomes the agent's display name (FR-010). */
export const DEFAULT_INTROS: Readonly<Record<string, string>> = {
  en: "Hi, I'm {name}, a virtual assistant.",
  ar: 'مرحباً، أنا {name}، مساعد افتراضي.',
};

export const DEFAULT_FALLBACK_MESSAGE = 'Thanks for your message. Our team will reply shortly.';

export const ApiSkillSchema = z.strictObject({
  id: skillId,
  name: z.string().trim().min(1).max(AI_LIMITS.apiSkillName),
  whenToUse: z.string().max(AI_LIMITS.whenToUse).default(''),
  inputs: z
    .array(
      z.strictObject({
        key: fieldName,
        description: z.string().max(AI_LIMITS.inputDescription).default(''),
        required: z.boolean().default(true),
      }),
    )
    .max(AI_LIMITS.apiInputs)
    .default([]),
  /** True when the call changes something; the customer must confirm first (FR-031). */
  changesData: z.boolean().default(false),
  request: z.strictObject({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
    url: z.string().max(2048).default(''),
    headers: z.array(NameValue).max(AI_LIMITS.apiHeaders).default([]),
    query: z.array(NameValue).max(AI_LIMITS.apiQuery).default([]),
    body: z.string().max(AI_LIMITS.apiBodyLength).nullable().default(null),
    timeoutSeconds: z.int().min(AI_LIMITS.apiTimeoutMin).max(AI_LIMITS.apiTimeoutMax).default(5),
  }),
  /** Reply fields the agent may use: `from` is a dotted path in the JSON reply, `to` the name it sees. */
  map: z
    .array(z.strictObject({ from: z.string().min(1).max(200), to: fieldName }))
    .max(AI_LIMITS.apiMap)
    .default([]),
});
export type ApiSkill = z.infer<typeof ApiSkillSchema>;

export const AgentSkillsSchema = z.strictObject({
  buttons: z.boolean().default(true),
  lists: z.boolean().default(true),
  media: z
    .array(z.strictObject({ mediaId: z.uuid(), description: z.string().max(AI_LIMITS.skillDescription).default('') }))
    .max(AI_LIMITS.media)
    .default([]),
  memory: z
    .array(z.strictObject({ key: z.string().min(1).max(100), description: z.string().max(AI_LIMITS.skillDescription).default('') }))
    .max(AI_LIMITS.memory)
    .default([]),
  api: z.array(ApiSkillSchema).max(AI_LIMITS.apiSkills).default([]),
  flows: z
    .array(z.strictObject({ flowId: z.uuid(), whenToUse: z.string().max(AI_LIMITS.whenToUse).default('') }))
    .max(AI_LIMITS.flowSkills)
    .default([]),
});
export type AgentSkills = z.infer<typeof AgentSkillsSchema>;

export const AgentConfigSchema = z.strictObject({
  version: z.literal(1),
  displayName: z.string().trim().min(1).max(AI_LIMITS.displayName),
  businessDetails: z.string().max(AI_LIMITS.businessDetails).default(''),
  goal: z.string().max(AI_LIMITS.goal).default(''),
  tone: z
    .strictObject({ preset: z.enum(TONE_PRESETS).default('friendly'), notes: z.string().max(AI_LIMITS.toneNotes).default('') })
    .default({ preset: 'friendly', notes: '' }),
  guardrails: z.array(z.string().trim().min(1).max(AI_LIMITS.guardrailLength)).max(AI_LIMITS.guardrails).default([]),
  replyLanguages: z.array(LanguageCodeSchema).max(AI_LIMITS.replyLanguages).default(['en', 'ar']),
  intro: z.record(LanguageCodeSchema, z.string().max(AI_LIMITS.intro)).default({ ...DEFAULT_INTROS }),
  maxReplyChars: z.int().min(AI_LIMITS.maxReplyCharsMin).max(AI_LIMITS.maxReplyCharsMax).default(AI_LIMITS.maxReplyCharsMax),
  whenUnsure: z.enum(['say_so', 'hand_over']).default('say_so'),
  handOverTopics: z.array(z.string().trim().min(1).max(AI_LIMITS.topicLength)).max(AI_LIMITS.handOverTopics).default([]),
  replyCap: z.int().min(AI_LIMITS.replyCapMin).max(AI_LIMITS.replyCapMax).default(20),
  fallbackMessage: z.string().trim().min(1).max(AI_LIMITS.fallbackMessage).default(DEFAULT_FALLBACK_MESSAGE),
  skills: AgentSkillsSchema.default({ buttons: true, lists: true, media: [], memory: [], api: [], flows: [] }),
});
export type AgentConfig = z.infer<typeof AgentConfigSchema>;

/** A new agent's draft: our defaults with the given display name. */
export function defaultAgentConfig(displayName = 'Assistant'): AgentConfig {
  return AgentConfigSchema.parse({ version: 1, displayName: displayName.trim().slice(0, AI_LIMITS.displayName) || 'Assistant' });
}

export interface AgentProblem {
  code: string;
  message: string;
  field: string | null;
}

const SECRET_PATTERN = /\{secret:[^}]+\}/;
const INPUT_PATTERN = /\{input:([^}]+)\}/g;

/** Problems that block publishing and need no database (FR-005); the server adds the rest. */
export function agentConfigProblems(config: AgentConfig): AgentProblem[] {
  const problems: AgentProblem[] = [];
  const add = (code: string, message: string, field: string | null) => problems.push({ code, message, field });

  if (!config.goal.trim()) add('NO_GOAL', 'Write what the agent is for.', 'goal');
  if (config.replyLanguages.length === 0) add('NO_LANGUAGE', 'Choose at least one reply language.', 'replyLanguages');
  for (const language of config.replyLanguages) {
    if (!config.intro[language]?.trim()) add('INTRO_MISSING', `Write the introduction for "${language}".`, `intro.${language}`);
  }

  config.skills.media.forEach((media, i) => {
    if (!media.description.trim()) add('SKILL_WITHOUT_DESCRIPTION', 'Say when to send this file.', `skills.media[${i}].description`);
  });
  config.skills.memory.forEach((memory, i) => {
    if (!memory.description.trim()) add('SKILL_WITHOUT_DESCRIPTION', 'Describe what this attribute holds.', `skills.memory[${i}].description`);
  });
  config.skills.flows.forEach((flow, i) => {
    if (!flow.whenToUse.trim()) add('SKILL_WITHOUT_DESCRIPTION', 'Say when to start this flow.', `skills.flows[${i}].whenToUse`);
  });

  const seen = new Set<string>();
  config.skills.api.forEach((skill, i) => {
    const at = `skills.api[${i}]`;
    if (seen.has(skill.id)) add('DUPLICATE_SKILL_ID', `Another skill already uses the id "${skill.id}".`, `${at}.id`);
    seen.add(skill.id);
    if (!skill.whenToUse.trim()) add('SKILL_WITHOUT_DESCRIPTION', 'Say when the agent should use this skill.', `${at}.whenToUse`);
    if (!/^https:\/\//i.test(skill.request.url.trim())) add('NOT_HTTPS', 'The address must start with https://.', `${at}.request.url`);

    const outsideHeaders = [skill.request.url, skill.request.body ?? '', ...skill.request.query.map((q) => `${q.name}${q.value}`)];
    if (outsideHeaders.some((value) => SECRET_PATTERN.test(value))) {
      add('SECRET_OUTSIDE_HEADER', 'Secrets can only be used in headers.', `${at}.request`);
    }

    const inputs = new Set(skill.inputs.map((input) => input.key));
    const used = [skill.request.url, skill.request.body ?? '', ...skill.request.query.map((q) => q.value), ...skill.request.headers.map((h) => h.value)];
    for (const value of used) {
      for (const match of value.matchAll(INPUT_PATTERN)) {
        if (!inputs.has(match[1]!)) add('UNKNOWN_INPUT', `The request uses {input:${match[1]}}, which is not one of the skill's inputs.`, `${at}.request`);
      }
    }
  });

  return problems;
}
