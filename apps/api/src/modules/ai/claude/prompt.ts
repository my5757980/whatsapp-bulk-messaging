import type Anthropic from '@anthropic-ai/sdk';
import { AI_LIMITS, maskSensitive, type AgentConfig } from '@wbm/shared';
import { PLATFORM_RULES_V1 } from './platform-rules.js';

// The prompt layout of research R7 (T040), in the order the API caches: tools (tools.ts) → system
// (fixed rules, then the agent's instructions with a breakpoint) → the knowledge as a user turn with
// a breakpoint → the conversation → the customer's new text → this turn's context as a system
// message. Knowledge sits in a user turn so page and file text never carries operator authority.
// The contact's phone number is never part of any of it (FR-048).

export interface KnowledgeItem {
  /** `src:<sourceId>` for written answers, `chunk:<chunkId>` for file and page chunks. */
  id: string;
  kind: 'ANSWER' | 'FILE' | 'WEBSITE';
  title: string;
  text: string;
}

export interface PromptCatalog {
  media: Array<{ id: string; name: string; description: string }>;
  flows: Array<{ id: string; name: string; whenToUse: string }>;
  memory: Array<{ key: string; label: string; type: string; description: string }>;
}

export interface TurnContext {
  contact: ContactFacts;
  localTime: string;
  timeZone: string;
  teamOpen: boolean;
  nextOpening: string | null;
  firstReply: boolean;
  pendingConfirmation: { skillName: string; inputs: Record<string, string> } | null;
  /** The reply cap is reached: this reply hands over (FR-023). */
  handOverNow?: boolean;
  /** The AI conversation already had a question the agent could not answer (the repeat rule). */
  couldNotAnswerBefore?: boolean;
}

export interface PromptInput {
  config: AgentConfig;
  catalog: PromptCatalog;
  knowledge: { mode: 'WHOLE' | 'SEARCH'; items: KnowledgeItem[] };
  retrieved: KnowledgeItem[];
  history: Array<{ from: 'customer' | 'agent'; text: string }>;
  customerText: string;
  turn: TurnContext;
}

export interface BuiltPrompt {
  system: Anthropic.Beta.BetaTextBlockParam[];
  messages: Array<Anthropic.Beta.BetaMessageParam | Anthropic.Beta.BetaSystemMessageParam>;
}

export interface ContactFacts {
  name: string | null;
  attributes: Record<string, string>;
  tags: string[];
}

/** What the agent may know about the contact: name, allowed attributes and tags; never the phone. */
export function contactFacts(
  contact: { name: string | null; phoneE164?: string | null; attributes: Record<string, unknown>; tags: string[] },
  allowedAttributes: readonly string[],
): ContactFacts {
  const attributes: Record<string, string> = {};
  for (const key of allowedAttributes) {
    const value = contact.attributes[key];
    if (value !== undefined && value !== null && value !== '') attributes[key] = maskSensitive(String(value));
  }
  return { name: contact.name?.trim() || null, attributes, tags: [...contact.tags] };
}

const KIND_ORDER: Record<KnowledgeItem['kind'], number> = { ANSWER: 0, FILE: 1, WEBSITE: 2 };

/** Knowledge text cannot close its own tags, and titles cannot break their attribute. */
function escapeText(text: string): string {
  return text.replace(/<\/?\s*(source|knowledge|retrieved|results|agent|turn_context)\b/gi, (match) => match.replace('<', '‹'));
}

function escapeAttribute(text: string): string {
  return text.replace(/"/g, "'").replace(/[\r\n]+/g, ' ');
}

export function renderSource(item: KnowledgeItem): string {
  return `<source id="${item.id}" kind="${item.kind}" title="${escapeAttribute(item.title)}">\n${escapeText(item.text)}\n</source>`;
}

export function renderInstructions(config: AgentConfig, catalog: PromptCatalog): string {
  const lines: string[] = ['<agent>'];
  lines.push(`Name: ${config.displayName}`);
  lines.push(`Goal: ${config.goal.trim() || '(not set)'}`);
  if (config.businessDetails.trim()) lines.push(`Business details:\n${config.businessDetails.trim()}`);
  lines.push(`Tone: ${config.tone.preset}${config.tone.notes.trim() ? `. ${config.tone.notes.trim()}` : ''}`);
  if (config.guardrails.length) lines.push(`Guardrails:\n${config.guardrails.map((g) => `- ${g}`).join('\n')}`);
  lines.push(`Hand-over topics: ${config.handOverTopics.length ? config.handOverTopics.join(', ') : '(none)'}`);
  lines.push(`When you cannot answer: ${config.whenUnsure === 'hand_over' ? 'hand the chat over' : 'say so and offer a person'}`);
  lines.push(`Reply languages: ${config.replyLanguages.join(', ') || 'en'} (the first is the fallback)`);
  lines.push(`Maximum reply length: ${config.maxReplyChars} characters`);
  lines.push(`Reply buttons allowed: ${config.skills.buttons ? 'yes' : 'no'}. Lists allowed: ${config.skills.lists ? 'yes' : 'no'}.`);
  if (catalog.media.length) lines.push(`Shared files:\n${catalog.media.map((m) => `- id ${m.id}: "${escapeAttribute(m.name)}" — ${m.description}`).join('\n')}`);
  if (catalog.memory.length) lines.push(`Attributes you may fill:\n${catalog.memory.map((m) => `- ${m.key} (${m.type}, "${escapeAttribute(m.label)}"): ${m.description}`).join('\n')}`);
  if (catalog.flows.length) lines.push(`Flows you may start:\n${catalog.flows.map((f) => `- id ${f.id}: "${escapeAttribute(f.name)}" — ${f.whenToUse}`).join('\n')}`);
  lines.push('</agent>');
  return lines.join('\n');
}

/** Whole mode: every item by priority. Search mode: written answers within the budget, then a note. */
export function renderKnowledge(knowledge: PromptInput['knowledge']): string {
  const sorted = [...knowledge.items].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  if (knowledge.mode === 'WHOLE') {
    return `<knowledge>\n${sorted.length ? sorted.map(renderSource).join('\n') : '(no knowledge has been added)'}\n</knowledge>`;
  }
  const kept: string[] = [];
  let size = 0;
  for (const item of sorted.filter((i) => i.kind === 'ANSWER')) {
    const rendered = renderSource(item);
    if (size + rendered.length > AI_LIMITS.searchModeAnswerChars) break;
    kept.push(rendered);
    size += rendered.length + 1;
  }
  return `<knowledge>\n${kept.join('\n')}\nMore knowledge (files and website pages) is not shown here: use the search_knowledge tool to find it.\n</knowledge>`;
}

export function renderTurnContext(turn: TurnContext, retrieved: KnowledgeItem[]): string {
  const lines: string[] = ['<turn_context>'];
  lines.push(`Local time: ${turn.localTime} (${turn.timeZone}).`);
  lines.push(turn.teamOpen ? 'The team is in working hours.' : `The team is away${turn.nextOpening ? `; next opening: ${turn.nextOpening}` : ''}.`);
  lines.push(`First reply in this conversation: ${turn.firstReply ? 'yes' : 'no'}`);
  lines.push(`Customer name: ${turn.contact.name ?? 'unknown'}`);
  const attributes = Object.entries(turn.contact.attributes);
  lines.push(`Known attributes: ${attributes.length ? attributes.map(([k, v]) => `${k} = ${v}`).join('; ') : '(none)'}`);
  lines.push(`Tags: ${turn.contact.tags.length ? turn.contact.tags.join(', ') : '(none)'}`);
  if (turn.pendingConfirmation) {
    const inputs = Object.entries(turn.pendingConfirmation.inputs).map(([k, v]) => `${k} = ${v}`).join(', ');
    lines.push(`Pending confirmation: the customer was asked to confirm "${turn.pendingConfirmation.skillName}"${inputs ? ` with ${inputs}` : ''}.`);
  }
  if (turn.handOverNow) lines.push('This conversation reached its reply limit: hand the chat over to a person in this reply.');
  if (turn.couldNotAnswerBefore) lines.push('Earlier in this conversation you could not answer a question. If you cannot answer this one either, hand the chat over.');
  if (retrieved.length) lines.push(`<retrieved>\n${retrieved.map(renderSource).join('\n')}\n</retrieved>`);
  lines.push('</turn_context>');
  return lines.join('\n');
}

export function buildPrompt(input: PromptInput): BuiltPrompt {
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: 'text', text: PLATFORM_RULES_V1 },
    { type: 'text', text: renderInstructions(input.config, input.catalog), cache_control: { type: 'ephemeral' } },
  ];
  const history = input.history.slice(-AI_LIMITS.historyMessages).map(
    (message): Anthropic.Beta.BetaMessageParam => ({ role: message.from === 'customer' ? 'user' : 'assistant', content: maskSensitive(message.text) }),
  );
  const messages: BuiltPrompt['messages'] = [
    { role: 'user', content: [{ type: 'text', text: renderKnowledge(input.knowledge), cache_control: { type: 'ephemeral' } }] },
    ...history,
    { role: 'user', content: maskSensitive(input.customerText) },
    { role: 'system', content: renderTurnContext(input.turn, input.retrieved) },
  ];
  return { system, messages };
}
