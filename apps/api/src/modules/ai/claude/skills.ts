import type { ApiSkill } from '@wbm/shared';
import { attributeText } from '../../inbox/conversations/visibility.js';
import { ApiCallError, callApi, mapFields, type ApiRequest, type ApiResponse } from '../../flows/steps/api-client.js';
import type { ClaudeTool } from './claude.client.js';

// API skills (004 US5, FR-030, FR-031; contracts/agent-config.md "Variables in API skill requests",
// claude-messages.md §3): one strict tool per skill. The platform fills the request with the 003
// place-aware encoding, so the model never sees secrets, the phone or the raw reply: only the
// fields the manager mapped go back. Skills that change data need the customer's confirmation on a
// later turn (research R12) and are only simulated in the preview.

/** A call the customer was asked to confirm (ai_conversations.pending_confirmation). */
export interface PendingConfirmation {
  skillId: string;
  skillName: string;
  inputs: Record<string, string>;
}

/** One skill call of a turn, without values (ai_replies.skills and payload.ai.skills). */
export interface SkillCallRecord {
  skillId: string;
  name: string;
  outcome: 'OK' | 'FAILED' | 'CONFIRMATION_NEEDED' | 'SIMULATED';
}

export interface SkillContact {
  name: string | null;
  phoneE164: string | null;
  attributes: Record<string, unknown>;
}

export interface SkillRuntime {
  /** `preview` runs read-only skills but only simulates skills that change data. */
  mode: 'live' | 'preview';
  contact: SkillContact;
  /** Decrypted values of the agent's secrets, by id. */
  secrets: ReadonlyMap<string, string>;
  /** The call the customer was asked to confirm on an earlier turn. */
  pending: PendingConfirmation | null;
  /** The HTTP client; the 003 safe client by default. */
  call?: (request: ApiRequest) => Promise<ApiResponse>;
}

export interface SkillSession {
  tools: ClaudeTool[];
  calls: SkillCallRecord[];
  /** "Would call …" lines for the preview. */
  wouldDo: string[];
  /** The confirmation to keep after this turn: unchanged, replaced or cleared. */
  pending: () => PendingConfirmation | null;
}

export type SkillToolResult = { ok: true; fields: Record<string, string | number>; simulated?: true } | { ok: false; reason: 'timeout' | 'error_status' | 'blocked' | 'confirmation_needed' };

const INPUT_LIMIT = 200;
const VARIABLE = /\{(input:[A-Za-z0-9_]+|contact:name|contact:phone|attr:[A-Za-z0-9_]+|secret:[0-9a-f-]{36})\}/g;
const SECRET = /\{secret:([0-9a-f-]{36})\}/g;

const plain = (value: string) => value;
const headerSafe = (value: string) => value.replace(/[\r\n]+/g, ' ');
const inJsonString = (value: string) => JSON.stringify(value).slice(1, -1);

/** Ids of the secrets a skill's headers use. */
export function skillSecretIds(skill: Pick<ApiSkill, 'request'>): string[] {
  return [...new Set(skill.request.headers.flatMap((h) => [...h.value.matchAll(SECRET)].map((m) => m[1]!)))];
}

/** The tool name of a skill. */
export function skillToolName(skill: Pick<ApiSkill, 'id'>): string {
  return `skill_${skill.id}`;
}

function variable(key: string, inputs: Record<string, string>, contact: SkillContact): string {
  if (key.startsWith('input:')) return inputs[key.slice('input:'.length)] ?? '';
  if (key === 'contact:name') return contact.name?.trim() ?? '';
  if (key === 'contact:phone') return contact.phoneE164 ?? '';
  if (key.startsWith('attr:')) return attributeText(contact.attributes[key.slice('attr:'.length)]) ?? '';
  return '';
}

function fill(template: string, inputs: Record<string, string>, runtime: Pick<SkillRuntime, 'contact' | 'secrets'>, encode: (value: string) => string, withSecrets: boolean): string {
  return template.replace(VARIABLE, (match, key: string) => {
    if (key.startsWith('secret:')) return withSecrets ? (runtime.secrets.get(key.slice('secret:'.length)) ?? '') : match;
    return encode(variable(key, inputs, runtime.contact));
  });
}

/**
 * The HTTP request of a skill call with the 003 encoding: URL encoding in the address, query values
 * added as parameters, JSON escaping in the body, line breaks removed from headers; secrets only in
 * header values. A value can therefore never change the address, break the JSON or add a header.
 */
export function buildSkillRequest(skill: ApiSkill, inputs: Record<string, string>, runtime: Pick<SkillRuntime, 'contact' | 'secrets'>): ApiRequest {
  const request = skill.request;
  let url = fill(request.url.trim(), inputs, runtime, encodeURIComponent, false);
  if (request.query.length) {
    try {
      const parsed = new URL(url);
      for (const q of request.query) parsed.searchParams.append(fill(q.name, inputs, runtime, plain, false), fill(q.value, inputs, runtime, plain, false));
      url = parsed.toString();
    } catch {
      // An invalid address is reported by the client (BAD_URL).
    }
  }
  const headers: Record<string, string> = {};
  for (const header of request.headers) headers[header.name.trim()] = headerSafe(fill(header.value, inputs, runtime, headerSafe, true));
  const hasBody = (request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH') && Boolean(request.body?.trim());
  return {
    method: request.method,
    url,
    headers,
    ...(hasBody ? { body: fill(request.body!, inputs, runtime, inJsonString, false) } : {}),
    timeoutMs: request.timeoutSeconds * 1000,
  };
}

/** The mapped reply fields of a skill: what the model may see. */
export function skillFields(skill: Pick<ApiSkill, 'map'>, body: unknown): Record<string, string | number> {
  return mapFields(body, skill.map.map((m) => ({ path: m.from, answerName: m.to })));
}

/** Inputs as the platform uses them: strings of at most 200 characters, only the skill's keys. */
function cleanInputs(skill: ApiSkill, raw: Record<string, unknown>): Record<string, string> {
  const inputs: Record<string, string> = {};
  for (const input of skill.inputs) {
    const value = raw[input.key];
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') inputs[input.key] = [...String(value).trim()].slice(0, INPUT_LIMIT).join('');
  }
  return inputs;
}

const sameInputs = (a: Record<string, string>, b: Record<string, string>) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...keys].every((key) => (a[key] ?? '') === (b[key] ?? ''));
};

function failureReason(error: unknown): 'timeout' | 'error_status' | 'blocked' {
  if (!(error instanceof ApiCallError)) return 'error_status';
  if (error.reason === 'TIMEOUT') return 'timeout';
  if (error.reason === 'NOT_HTTPS' || error.reason === 'BLOCKED_ADDRESS' || error.reason === 'BAD_URL' || error.reason === 'REDIRECT') return 'blocked';
  return 'error_status';
}

/** Runs one skill call (also the editor's test request); never throws. */
export async function runSkill(skill: ApiSkill, inputs: Record<string, string>, runtime: Pick<SkillRuntime, 'contact' | 'secrets' | 'call'>): Promise<SkillToolResult> {
  const call = runtime.call ?? callApi;
  try {
    const response = await call(buildSkillRequest(skill, inputs, runtime));
    if (response.status < 200 || response.status >= 300) return { ok: false, reason: 'error_status' };
    return { ok: true, fields: skillFields(skill, response.body) };
  } catch (error) {
    return { ok: false, reason: failureReason(error) };
  }
}

/**
 * The skill tools of one turn. Read-only skills run at once; a skill that changes data first answers
 * `confirmation_needed` and keeps the call as pending, and runs on a later turn when the model calls
 * it again with the same inputs (other inputs ask again). The preview simulates such skills.
 */
export function skillSession(skills: ApiSkill[], runtime: SkillRuntime): SkillSession {
  const calls: SkillCallRecord[] = [];
  const wouldDo: string[] = [];
  let next: PendingConfirmation | null | undefined;

  const tools = skills.map((skill): ClaudeTool => {
    const properties = Object.fromEntries(
      skill.inputs.map((input) => [input.key, { type: input.required ? 'string' : ['string', 'null'], description: input.description || input.key }]),
    );
    return {
      name: skillToolName(skill),
      description: `${skill.name}: ${skill.whenToUse}${skill.changesData ? ' This changes data: first tell the customer exactly what you will do, and call it only after they confirm.' : ''}`,
      // Strict tools list every property as required; optional inputs may be null.
      inputSchema: { type: 'object', additionalProperties: false, required: skill.inputs.map((i) => i.key), properties },
      run: async (raw) => {
        const inputs = cleanInputs(skill, raw);
        if (skill.changesData) {
          if (runtime.mode === 'preview') {
            const shown = Object.entries(inputs).map(([k, v]) => `${k} = ${v}`).join(', ');
            wouldDo.push(`Would call "${skill.name}"${shown ? ` with ${shown}` : ''}`);
            calls.push({ skillId: skill.id, name: skill.name, outcome: 'SIMULATED' });
            return JSON.stringify({ ok: true, fields: {}, simulated: true } satisfies SkillToolResult);
          }
          const pending = runtime.pending;
          if (!pending || pending.skillId !== skill.id || !sameInputs(pending.inputs, inputs)) {
            next = { skillId: skill.id, skillName: skill.name, inputs };
            calls.push({ skillId: skill.id, name: skill.name, outcome: 'CONFIRMATION_NEEDED' });
            return JSON.stringify({ ok: false, reason: 'confirmation_needed' } satisfies SkillToolResult);
          }
          next = null;
        }
        const result = await runSkill(skill, inputs, runtime);
        calls.push({ skillId: skill.id, name: skill.name, outcome: result.ok ? 'OK' : 'FAILED' });
        return JSON.stringify(result);
      },
    };
  });

  return { tools, calls, wouldDo, pending: () => (next === undefined ? runtime.pending : next) };
}
