// Shared helpers for the performance scripts (T196): a minimal dashboard API client that keeps the
// session and CSRF cookies, polling, and PASS/FAIL reporting. Talks to the API directly, so the
// web app does not need to run.
import { createHmac, randomUUID } from 'node:crypto';

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

  /** The session cookies, for requests made outside this client (the live event stream). */
  cookieHeader(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ');
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

/** The api's Meta app secret, from the environment or the repo's .env, to sign test webhooks. */
export function metaAppSecret(): string {
  if (!process.env.META_APP_SECRET) {
    try {
      process.loadEnvFile('.env');
    } catch {
      // No .env file: the variable must come from the environment.
    }
  }
  const secret = process.env.META_APP_SECRET;
  if (!secret) throw new Error("Set META_APP_SECRET to the api's value to send signed webhooks");
  return secret;
}

export interface InboundText {
  from: string;
  name: string;
  text: string;
}

/** Posts customer text messages to the api's webhook in one signed payload, as Meta would. */
export async function postInboundTexts(env: PerfEnv, secret: string, phoneNumberId: string, messages: InboundText[]): Promise<void> {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const waId = (phone: string) => phone.replace(/^\+/, '');
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'PERF_WABA',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550100', phone_number_id: phoneNumberId },
              contacts: messages.map((m) => ({ profile: { name: m.name }, wa_id: waId(m.from) })),
              messages: messages.map((m) => ({ from: waId(m.from), id: `wamid.perf.${randomUUID()}`, timestamp, type: 'text', text: { body: m.text } })),
            },
          },
        ],
      },
    ],
  });
  const signature = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  const res = await fetch(`${env.apiUrl}/api/webhooks/meta`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-hub-signature-256': signature },
    body: raw,
  });
  if (!res.ok) throw new Error(`Webhook -> ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

/** The 95th percentile of the samples (nearest rank). */
export function p95(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? Number.NaN;
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
