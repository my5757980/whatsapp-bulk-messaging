import type { AgentConfig, AgentProblem } from '@wbm/shared';

// AI agent types and query keys for the dashboard (contracts/ai-api.openapi.yaml, feature 004).

export type AgentStatus = 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';

export interface AgentSummary {
  id: string;
  name: string;
  status: AgentStatus;
  numbers: Array<{ id: string; displayPhone: string }>;
  testNumbers: string[];
  publishedVersion: { id: string; number: number; publishedAt: string; publishedBy: { id: string; name: string } | null } | null;
  hasUnpublishedChanges: boolean;
  last7Days: { replies: number; handedOver: number };
}

export interface AgentDetail extends AgentSummary {
  config: AgentConfig;
  draftRevision: number;
  draftUpdatedAt: string | null;
  problems: AgentProblem[];
  starterKey: string | null;
  secrets: Array<{ id: string; name: string; updatedAt: string }>;
}

export interface KnowledgeSource {
  id: string;
  kind: 'ANSWER' | 'WEBSITE' | 'FILE';
  title: string;
  enabled: boolean;
  status: 'PROCESSING' | 'READY' | 'FAILED';
  errorCode: string | null;
  errorMessage: string | null;
  question: string | null;
  answer: string | null;
  url: string | null;
  refreshWeekly: boolean;
  pagesRead: number | null;
  fileName: string | null;
  sizeBytes: number | null;
  charCount: number;
  lastRefreshedAt: string | null;
  replaceMe: boolean;
}

export interface KnowledgeList {
  sources: KnowledgeSource[];
  totalChars: number;
  mode: 'WHOLE' | 'SEARCH';
  limits: { answers: number; websites: number; files: number };
}

export interface UnansweredQuestion {
  id: string;
  text: string;
  askCount: number;
  firstAskedAt: string;
  lastAskedAt: string;
  resolvedAt: string | null;
}

// Separate branches, so refreshing the list never reloads an open editor (keys match by prefix).
export const aiKeys = {
  list: ['ai-agents', 'list'] as const,
  agent: (id: string) => ['ai-agents', 'agent', id] as const,
  knowledge: (id: string) => ['ai-agents', 'knowledge', id] as const,
  /** Both lists of an agent's unanswered questions. */
  unanswered: (id: string) => ['ai-agents', 'unanswered', id] as const,
  unansweredList: (id: string, status: 'open' | 'resolved') => ['ai-agents', 'unanswered', id, status] as const,
  versions: (id: string) => ['ai-agents', 'versions', id] as const,
};

export interface AgentVersion {
  id: string;
  number: number;
  publishedAt: string;
  publishedBy: { id: string; name: string } | null;
  isCurrent: boolean;
}

export interface PreviewMessage {
  from: 'customer' | 'agent';
  text: string;
}

/** What the draft would reply in the preview (FR-034); nothing is sent or changed. */
export interface PreviewResult {
  reply: { message: string; language: string | null; buttons: string[] | null; list: Record<string, unknown> | null; mediaId: string | null };
  sources: Array<{ id: string; kind: string; title: string }>;
  wouldDo: Array<{ kind: 'HAND_OVER' | 'REMEMBER' | 'START_FLOW' | 'OPT_OUT' | 'CALL_SKILL' | 'UNANSWERED'; description: string }>;
  usage: { costUsd?: number; durationMs?: number };
}

/** Reply languages offered in the editor (BCP 47 primary tags). */
export const LANGUAGES: Array<{ code: string; name: string }> = [
  { code: 'en', name: 'English' },
  { code: 'ar', name: 'Arabic' },
  { code: 'ur', name: 'Urdu' },
  { code: 'hi', name: 'Hindi' },
  { code: 'fr', name: 'French' },
  { code: 'ru', name: 'Russian' },
  { code: 'fa', name: 'Persian' },
  { code: 'tl', name: 'Tagalog' },
];

export const TONES: Array<{ value: AgentConfig['tone']['preset']; label: string }> = [
  { value: 'friendly', label: 'Friendly' },
  { value: 'professional', label: 'Professional' },
  { value: 'warm', label: 'Warm' },
  { value: 'concise', label: 'Concise' },
  { value: 'formal', label: 'Formal' },
];

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code;
}
