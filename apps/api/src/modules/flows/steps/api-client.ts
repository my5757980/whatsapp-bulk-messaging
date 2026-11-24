import { request } from 'node:https';
import { isIP } from 'node:net';
import { createSafeLookup as createLookup, isBlockedAddress, type Resolver } from '../../../common/http/safe-http.js';

// The HTTP client of API steps and test requests (003 T057, research R11, FR-014). Only HTTPS to
// public addresses: names are checked when they resolve (the connection uses the checked address,
// so there is no DNS-rebinding gap) and address literals before connecting. No redirects, a total
// timeout, a 100 KB reply cap, and JSON replies for mapping. Node's own https client is used, with a
// lookup that refuses non-public addresses, so the API needs no extra HTTP library.

export const RESPONSE_LIMIT_BYTES = 100 * 1024;

export type ApiCallFailure = 'BAD_URL' | 'NOT_HTTPS' | 'BLOCKED_ADDRESS' | 'REDIRECT' | 'TIMEOUT' | 'TOO_LARGE' | 'NOT_JSON' | 'NETWORK';

export class ApiCallError extends Error {
  constructor(
    readonly reason: ApiCallFailure,
    message: string,
  ) {
    super(message);
    this.name = 'ApiCallError';
  }
}

const blocked = () => new ApiCallError('BLOCKED_ADDRESS', 'This address is private or reserved, so a flow cannot call it');

// The address rules live in common/http/safe-http.ts (feature 006, T013). Flows and the AI agent keep
// their own error type, so a refused lookup is still an ApiCallError with the reason BLOCKED_ADDRESS.
export { isBlockedAddress };
export type { Resolver };

/** A `lookup` for https.request that refuses a name when any address it resolves to is not public. */
export function createSafeLookup(resolve?: Resolver) {
  return createLookup(resolve, blocked);
}

const safeLookup = createSafeLookup();

export interface ApiRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
}

export interface ApiResponse {
  status: number;
  /** Parsed JSON for 2xx replies (null when empty); null for other statuses. */
  body: unknown;
  /** The reply text, for the editor's test request. */
  text: string;
}

/** Makes one call; throws ApiCallError for refused or failed calls, returns the status otherwise. */
export function callApi(input: ApiRequest): Promise<ApiResponse> {
  let url: URL;
  try {
    url = new URL(input.url);
  } catch {
    return Promise.reject(new ApiCallError('BAD_URL', 'The address is not a valid URL'));
  }
  if (url.protocol !== 'https:') return Promise.reject(new ApiCallError('NOT_HTTPS', 'Only https:// addresses can be called'));
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((isIP(host) && isBlockedAddress(host)) || host === 'localhost' || host.endsWith('.localhost')) return Promise.reject(blocked());

  return new Promise<ApiResponse>((resolve, reject) => {
    let settled = false;
    const finish = (error: ApiCallError | null, response?: ApiResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const headers: Record<string, string | number> = { accept: 'application/json', ...input.headers };
    if (input.body !== undefined) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(input.body);
    }
    const req = request(url, { method: input.method, headers, lookup: safeLookup }, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400) {
        res.resume();
        finish(new ApiCallError('REDIRECT', `The address answered with a redirect (${status}), which flows do not follow`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT_BYTES) {
          finish(new ApiCallError('TOO_LARGE', 'The reply is larger than 100 KB'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', (error) => finish(new ApiCallError('NETWORK', error.message)));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (status < 200 || status >= 300) return finish(null, { status, body: null, text });
        if (!text.trim()) return finish(null, { status, body: null, text });
        try {
          finish(null, { status, body: JSON.parse(text) as unknown, text });
        } catch {
          finish(new ApiCallError('NOT_JSON', 'The reply is not JSON'));
        }
      });
    });
    const timer = setTimeout(() => {
      finish(new ApiCallError('TIMEOUT', `No reply within ${Math.round(input.timeoutMs / 100) / 10} s`));
      req.destroy();
    }, input.timeoutMs);
    req.on('error', (error) => finish(error instanceof ApiCallError ? error : new ApiCallError('NETWORK', error.message)));
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}

/** A value at a dotted path (`order.status`, `items.0.name`); undefined when the path is not there. */
export function pickPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const part of path.split('.')) {
    if (current === null || current === undefined) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined;
      current = current[Number(part)];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

/** Reply fields as answers: text (up to 1000 characters), numbers, and true/false as text. */
export function mapFields(body: unknown, map: Array<{ path: string; answerName: string }>): Record<string, string | number> {
  const answers: Record<string, string | number> = {};
  for (const { path, answerName } of map) {
    const value = pickPath(body, path);
    if (typeof value === 'string') answers[answerName] = value.slice(0, 1000);
    else if (typeof value === 'number' && Number.isFinite(value)) answers[answerName] = value;
    else if (typeof value === 'boolean') answers[answerName] = String(value);
  }
  return answers;
}
