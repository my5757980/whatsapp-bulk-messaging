// Shared helpers for the performance scripts (T196): a minimal dashboard API client that keeps the
// session and CSRF cookies, polling, and PASS/FAIL reporting. Talks to the API directly, so the
// web app does not need to run.

export interface PerfEnv {
  apiUrl: string;
  mockMetaUrl: string;
  email: string;
  password: string;
}

export function perfEnv(): PerfEnv {
  return {
    apiUrl: process.env.PERF_API_URL ?? 'http://localhost:4000',
    mockMetaUrl: process.env.PERF_MOCK_META_URL ?? 'http://localhost:4010',
    email: process.env.PERF_ADMIN_EMAIL ?? process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test',
    password: process.env.PERF_ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345',
  };
}

export class ApiClient {
  private readonly cookies = new Map<string, string>();

  private constructor(private readonly baseUrl: string) {}

  static async signIn(env: PerfEnv): Promise<ApiClient> {
    const client = new ApiClient(env.apiUrl);
    await client.request('POST', '/api/auth/login', { json: { email: env.email, password: env.password } });
    if (!client.cookies.has('csrf')) throw new Error('Sign-in did not return a CSRF cookie');
    return client;
  }

  async request<T>(method: string, path: string, opts: { json?: unknown; form?: FormData } = {}): Promise<T> {
    const headers: Record<string, string> = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const csrf = this.cookies.get('csrf');
    if (csrf && method !== 'GET') headers['x-csrf-token'] = decodeURIComponent(csrf);
    let body: string | FormData | undefined;
    if (opts.form) {
      body = opts.form;
    } else if (opts.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(opts.json);
    }
    const res = await fetch(`${this.baseUrl}${path}`, { method, headers, body });
    for (const cookie of res.headers.getSetCookie()) {
      const pair = cookie.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : undefined) as T;
  }

  get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  post<T>(path: string, json: unknown = {}): Promise<T> {
    return this.request<T>('POST', path, { json });
  }

  patch<T>(path: string, json: unknown): Promise<T> {
    return this.request<T>('PATCH', path, { json });
  }

  upload<T>(path: string, form: FormData): Promise<T> {
    return this.request<T>('POST', path, { form });
  }
}

/** Polls `check` until it returns a value; `check` may throw to stop early. */
export async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${formatDuration(timeoutMs)} waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** CSV body as a file part for multipart uploads. */
export function csvPart(lines: string[]): Blob {
  return new Blob([`${lines.join('\n')}\n`], { type: 'text/csv' });
}

/** Prints the checks and sets the exit code; returns whether all passed. */
export function report(title: string, checks: Array<[label: string, ok: boolean, detail: string]>): boolean {
  const passed = checks.every(([, ok]) => ok);
  console.log(`\n${passed ? 'PASS' : 'FAIL'}  ${title}`);
  for (const [label, ok, detail] of checks) console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${label}: ${detail}`);
  if (!passed) process.exitCode = 1;
  return passed;
}

export function run(main: () => Promise<void>): void {
  main().catch((error: unknown) => {
    console.error(`\nFAIL  ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
