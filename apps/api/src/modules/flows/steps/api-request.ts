import type { StepOf } from '@wbm/shared';
import { attributeText } from '../../inbox/conversations/visibility.js';
import type { ApiRequest } from './api-client.js';

// The HTTP request of an API step (003 T058, contracts/flow-graph.md "Variables"): contact values and
// answers are filled in and encoded for where they go (URL, JSON body, header), so a customer's
// answer can never change the address, break the JSON or add a header. Secrets ({secret:<id>}) are
// filled in header values only.

type ApiStep = StepOf<'api'>;

export interface ApiRenderContext {
  contact: { name: string | null; phoneE164: string | null; attributes: Record<string, unknown> };
  answers: Record<string, unknown>;
  /** Decrypted values of this flow's secrets, by id. */
  secrets: ReadonlyMap<string, string>;
}

const VARIABLE = /\{(first_name|last_name|name|phone|attr:[A-Za-z0-9_]+|answer:[a-z][a-z0-9_]{0,39}|secret:[0-9a-f-]{36})\}/g;
const SECRET = /\{secret:([0-9a-f-]{36})\}/g;

/** Ids of the secrets a step's headers use. */
export function secretIdsIn(step: Pick<ApiStep, 'headers'>): string[] {
  return [...new Set(step.headers.flatMap((h) => [...h.value.matchAll(SECRET)].map((m) => m[1]!)))];
}

function valueOf(key: string, ctx: ApiRenderContext): string {
  const [first, ...rest] = (ctx.contact.name ?? '').trim().split(/\s+/).filter(Boolean);
  if (key === 'first_name') return first ?? '';
  if (key === 'last_name') return rest.join(' ');
  if (key === 'name') return ctx.contact.name?.trim() ?? '';
  if (key === 'phone') return ctx.contact.phoneE164 ?? '';
  if (key.startsWith('attr:')) return attributeText(ctx.contact.attributes[key.slice('attr:'.length)]) ?? '';
  const answer = ctx.answers[key.slice('answer:'.length)];
  return typeof answer === 'string' || typeof answer === 'number' || typeof answer === 'boolean' ? String(answer) : '';
}

function fill(template: string, ctx: ApiRenderContext, encode: (value: string) => string, withSecrets: boolean): string {
  return template.replace(VARIABLE, (match, key: string) => {
    if (key.startsWith('secret:')) return withSecrets ? (ctx.secrets.get(key.slice('secret:'.length)) ?? '') : match;
    return encode(valueOf(key, ctx));
  });
}

const plain = (value: string) => value;
const headerSafe = (value: string) => value.replace(/[\r\n]+/g, ' ');
const inJsonString = (value: string) => JSON.stringify(value).slice(1, -1);

export function buildApiRequest(step: ApiStep, ctx: ApiRenderContext): ApiRequest {
  let url = fill(step.url.trim(), ctx, encodeURIComponent, false);
  if (step.query.length) {
    try {
      const parsed = new URL(url);
      for (const q of step.query) parsed.searchParams.append(fill(q.name, ctx, plain, false), fill(q.value, ctx, plain, false));
      url = parsed.toString();
    } catch {
      // An invalid address is reported by the client (BAD_URL).
    }
  }
  const headers: Record<string, string> = {};
  for (const header of step.headers) headers[header.name.trim()] = headerSafe(fill(header.value, ctx, headerSafe, true));
  const hasBody = (step.method === 'POST' || step.method === 'PUT' || step.method === 'PATCH') && Boolean(step.body?.trim());
  return {
    method: step.method,
    url,
    headers,
    ...(hasBody ? { body: fill(step.body!, ctx, inJsonString, false) } : {}),
    timeoutMs: step.timeoutSeconds * 1000,
  };
}
