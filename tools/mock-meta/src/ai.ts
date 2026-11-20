// Fake Claude Messages endpoint for local runs and e2e tests (feature 004, T006,
// specs/004-ai-agent/contracts/claude-messages.md §7). It never calls a real model: replies come from
// scripted rules or from the knowledge the platform put in the request.

interface ContentBlock {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

interface ClaudeMessage {
  role?: string;
  content?: string | ContentBlock[];
}

interface ClaudeRequest {
  model?: string;
  system?: string | ContentBlock[];
  messages?: ClaudeMessage[];
  tools?: Array<{ name?: string }>;
  output_config?: { format?: unknown; effort?: string };
}

/** The reply JSON of contracts/claude-messages.md §4; rules may give only some fields. */
type AgentReply = Record<string, unknown>;

export interface AiRule {
  when?: {
    /** Case-insensitive text the customer's latest message must contain. */
    lastUserContains?: string;
    /** Case-insensitive text the system prompt or instructions must contain (to target one agent). */
    systemContains?: string;
    /** True: only after a tool result; false: only before any tool result in this turn. */
    hasToolResult?: boolean;
  };
  /** A structured reply (merged over the defaults). */
  reply?: AgentReply;
  /** Plain text for requests without a JSON format (the team assistant). */
  text?: string;
  /** Return a tool call first; the platform runs the tool and calls again. */
  toolCall?: { name: string; input: Record<string, unknown> };
  /** Simulate an API error (for example 500, 401 or 429). */
  status?: number;
  /** Simulate a refusal or a cut-off answer. */
  stopReason?: 'refusal' | 'max_tokens';
}

const MAX_KEPT = 200;
let rules: AiRule[] = [];
const requests: Array<{ at: string; path: string; body: ClaudeRequest }> = [];
let counter = 0;

export function setAiRules(next: unknown): number {
  rules = Array.isArray(next) ? (next as AiRule[]) : [];
  return rules.length;
}

export function aiRequests(): { count: number; requests: typeof requests } {
  return { count: requests.length, requests };
}

export function resetAi(): void {
  rules = [];
  requests.length = 0;
}

function blocks(content: ClaudeMessage['content']): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  return Array.isArray(content) ? content : [];
}

function textOf(content: ClaudeMessage['content']): string {
  return blocks(content)
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : b.type === 'tool_result' ? textOfToolResult(b.content) : ''))
    .join('\n');
}

function textOfToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c: ContentBlock) => (typeof c?.text === 'string' ? c.text : '')).join('\n');
  return '';
}

/** The customer's latest words: the last user message that is not a tool result or a knowledge block. */
function lastCustomerText(messages: ClaudeMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role !== 'user') continue;
    const parts = blocks(message.content).filter((b) => b.type === 'text' && typeof b.text === 'string' && !b.text.trimStart().startsWith('<knowledge>'));
    if (parts.length) return parts.map((b) => b.text).join('\n');
  }
  return '';
}

function lastUserHasToolResult(messages: ClaudeMessage[]): boolean {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  return blocks(last?.content).some((b) => b.type === 'tool_result');
}

interface Source {
  id: string;
  kind: string;
  title: string;
  text: string;
}

/** Sources the platform rendered as <source id="…" kind="…" title="…">text</source> anywhere in the request. */
function sourcesIn(body: ClaudeRequest): Source[] {
  const all = [
    typeof body.system === 'string' ? body.system : blocks(body.system).map((b) => b.text ?? '').join('\n'),
    ...(body.messages ?? []).map((m) => textOf(m.content)),
  ].join('\n');
  const found: Source[] = [];
  const pattern = /<source id="([^"]+)" kind="([^"]*)" title="([^"]*)">([\s\S]*?)<\/source>/g;
  for (const match of all.matchAll(pattern)) {
    found.push({ id: match[1]!, kind: match[2]!, title: match[3]!, text: match[4]!.trim() });
  }
  return found;
}

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => [...w].length >= 3),
  );

function bestSource(question: string, sources: Source[]): Source | undefined {
  const asked = words(question);
  let best: { source: Source; score: number } | undefined;
  for (const source of sources) {
    const have = words(`${source.title} ${source.text}`);
    let score = 0;
    for (const word of asked) if (have.has(word)) score += 1;
    if (score > 0 && (!best || score > best.score)) best = { source, score };
  }
  return best?.source;
}

const DEFAULT_REPLY: AgentReply = {
  message: '',
  language: 'en',
  buttons: null,
  list: null,
  mediaId: null,
  usedSources: [],
  unanswered: null,
  handOver: null,
  remember: null,
  startFlow: null,
  optOut: null,
};

function defaultReply(body: ClaudeRequest, question: string): AgentReply {
  const language = /[\u0600-\u06FF]/.test(question) ? 'ar' : 'en';
  const source = bestSource(question, sourcesIn(body));
  if (source) {
    const answer = source.text.replace(/^Q:[^\n]*\n(A:\s*)?/i, '').slice(0, 300);
    return { ...DEFAULT_REPLY, message: answer, language, usedSources: [source.id] };
  }
  return {
    ...DEFAULT_REPLY,
    message: "I don't have that information yet. I can connect you with our team.",
    language,
    unanswered: question.slice(0, 100) || 'an unknown question',
  };
}

function matches(rule: AiRule, body: ClaudeRequest, question: string, hasToolResult: boolean): boolean {
  const when = rule.when ?? {};
  if (when.lastUserContains && !question.toLowerCase().includes(when.lastUserContains.toLowerCase())) return false;
  if (when.systemContains) {
    const system = typeof body.system === 'string' ? body.system : blocks(body.system).map((b) => b.text ?? '').join('\n');
    if (!system.toLowerCase().includes(when.systemContains.toLowerCase())) return false;
  }
  if (when.hasToolResult !== undefined && when.hasToolResult !== hasToolResult) return false;
  // A tool call is offered only once per turn unless the rule asks otherwise.
  if (rule.toolCall && when.hasToolResult === undefined && hasToolResult) return false;
  return true;
}

const estimateTokens = (value: unknown): number => Math.max(1, Math.ceil(JSON.stringify(value ?? '').length / 4));

export interface AiResponse {
  status: number;
  body: unknown;
}

/** Answers one `POST /anthropic/v1/messages` call. */
export function answerMessages(path: string, raw: string): AiResponse {
  const body = (raw ? JSON.parse(raw) : {}) as ClaudeRequest;
  requests.push({ at: new Date().toISOString(), path, body });
  if (requests.length > MAX_KEPT) requests.shift();

  const messages = body.messages ?? [];
  const question = lastCustomerText(messages);
  const hasToolResult = lastUserHasToolResult(messages);
  const rule = rules.find((r) => matches(r, body, question, hasToolResult));
  counter += 1;

  if (rule?.status && rule.status >= 400) {
    const type = rule.status === 401 ? 'authentication_error' : rule.status === 429 ? 'rate_limit_error' : 'api_error';
    return { status: rule.status, body: { type: 'error', error: { type, message: `mock ${type}` } } };
  }

  const base = {
    id: `msg_mock_${counter}`,
    type: 'message',
    role: 'assistant',
    model: body.model ?? 'claude-opus-5-5',
    stop_sequence: null,
    usage: { input_tokens: estimateTokens(body), output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  };

  if (rule?.toolCall) {
    return {
      status: 200,
      body: { ...base, content: [{ type: 'tool_use', id: `toolu_mock_${counter}`, name: rule.toolCall.name, input: rule.toolCall.input }], stop_reason: 'tool_use' },
    };
  }

  const structured = body.output_config?.format !== undefined;
  const text = structured ? JSON.stringify({ ...DEFAULT_REPLY, ...(rule?.reply ? rule.reply : defaultReply(body, question)) }) : (rule?.text ?? 'Done.');
  const stopReason = rule?.stopReason ?? 'end_turn';
  const content = stopReason === 'refusal' ? [] : [{ type: 'text', text: stopReason === 'max_tokens' ? text.slice(0, Math.max(1, Math.floor(text.length / 2))) : text }];
  return { status: 200, body: { ...base, content, stop_reason: stopReason } };
}
