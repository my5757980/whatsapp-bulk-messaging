// Browser API client (T066): same-origin /api (proxied to NestJS), cookies included,
// CSRF double-submit header on mutations, contract Error shape parsed into ApiError.

export interface ApiErrorDetail {
  field: string;
  issue: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: ApiErrorDetail[],
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function readCookie(name: string): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.split('; ').find((c) => c.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : undefined;
}

const SAFE_METHODS = new Set(['GET', 'HEAD']);

export interface ApiRequestInit extends Omit<RequestInit, 'body'> {
  json?: unknown;
  body?: BodyInit | null;
}

export async function api<T>(path: string, init: ApiRequestInit = {}): Promise<T> {
  const method = (init.method ?? 'GET').toUpperCase();
  const headers = new Headers(init.headers);
  if (init.json !== undefined) headers.set('content-type', 'application/json');
  if (!SAFE_METHODS.has(method)) {
    const csrf = readCookie('csrf');
    if (csrf) headers.set('x-csrf-token', csrf);
  }

  const { json, ...rest } = init;
  const res = await fetch(`/api${path}`, {
    ...rest,
    method,
    headers,
    credentials: 'include',
    body: json !== undefined ? JSON.stringify(json) : (init.body ?? null),
  });

  if (res.status === 401 && typeof window !== 'undefined' && !path.startsWith('/auth/login')) {
    window.location.assign('/login');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { code?: string; message?: string; details?: ApiErrorDetail[] };
    throw new ApiError(res.status, body.code ?? 'HTTP_ERROR', body.message ?? res.statusText, body.details);
  }
  if (res.status === 204) return undefined as T;
  const type = res.headers.get('content-type') ?? '';
  return (type.includes('application/json') ? res.json() : res.text()) as Promise<T>;
}
