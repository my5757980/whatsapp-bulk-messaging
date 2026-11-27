// A thin Stripe client (feature 008, research R1, contracts/stripe.md): seven v1 calls over Node's
// fetch with the pinned Stripe-Version, form-encoded bodies, idempotency keys on every POST, and
// three retries for network errors, 429 and 5xx with the same key. No SDK.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { PAYMENT_CHECK_METADATA_KEY, PAYMENT_REQUEST_METADATA_KEY } from '@wbm/shared';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';

/** The events the webhook endpoint subscribes to (R3). */
export const STRIPE_WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'checkout.session.expired',
  'payment_intent.payment_failed',
  'charge.refunded',
] as const;

export class StripeApiError extends Error {
  constructor(
    readonly status: number,
    readonly type: string | null,
    readonly code: string | null,
    readonly declineCode: string | null,
    readonly param: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'StripeApiError';
  }
}

export class StripeNetworkError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'StripeNetworkError';
  }
}

export interface StripeAccount {
  id: string;
  name: string | null;
  country: string | null;
  defaultCurrency: string | null;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  currentlyDue: string[];
}

export interface StripeSession {
  id: string;
  url: string | null;
  status: 'open' | 'complete' | 'expired';
  paymentStatus: string;
  amountTotal: number | null;
  currency: string | null;
  paymentIntentId: string | null;
  /** Unix seconds. */
  expiresAt: number;
  metadata: Record<string, string>;
  livemode: boolean;
}

export interface CreateSessionInput {
  /** Our payment request; null only for the connection check session. */
  requestId: string | null;
  check?: boolean;
  amountMinor: number;
  currency: string;
  description: string;
  reference?: string | null;
  /** Unix seconds, already clamped to Stripe's 30 minutes – 24 hours. */
  expiresAt: number;
  successUrl: string;
  idempotencyKey: string;
}

type Obj = Record<string, unknown>;
const obj = (value: unknown): Obj => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Obj) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const idOf = (value: unknown): string | null => str(value) ?? str(obj(value).id);

/** application/x-www-form-urlencoded with Stripe's bracketed keys; scalar arrays use `key[]`. */
export function encodeStripeForm(input: Obj): string {
  const params = new URLSearchParams();
  const add = (key: string, value: unknown): void => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item, i) => {
        if (item !== null && typeof item === 'object') add(`${key}[${i}]`, item);
        else add(`${key}[]`, item);
      });
      return;
    }
    if (typeof value === 'object') {
      for (const [inner, v] of Object.entries(value as Obj)) add(`${key}[${inner}]`, v);
      return;
    }
    params.append(key, String(value));
  };
  for (const [key, value] of Object.entries(input)) add(key, value);
  return params.toString();
}

function toSession(raw: unknown): StripeSession {
  const s = obj(raw);
  const status = s.status === 'complete' || s.status === 'expired' ? s.status : 'open';
  const metadata: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj(s.metadata))) if (typeof v === 'string') metadata[k] = v;
  return {
    id: str(s.id) ?? '',
    url: str(s.url),
    status,
    paymentStatus: str(s.payment_status) ?? 'unpaid',
    amountTotal: typeof s.amount_total === 'number' ? s.amount_total : null,
    currency: str(s.currency),
    paymentIntentId: idOf(s.payment_intent),
    expiresAt: typeof s.expires_at === 'number' ? s.expires_at : 0,
    metadata,
    livemode: s.livemode === true,
  };
}

@Injectable()
export class StripeClient {
  private readonly baseUrl: string;
  private readonly version: string;
  private readonly timeoutMs: number;
  private readonly retryDelaysMs: readonly number[];

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Optional() @Inject('STRIPE_CLIENT_OPTIONS') options?: { timeoutMs?: number; retryDelaysMs?: number[] },
  ) {
    this.baseUrl = config.STRIPE_API_BASE_URL.replace(/\/+$/, '');
    this.version = config.STRIPE_API_VERSION;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
    // Tests use short waits so outage cases stay fast; production waits as research R1 says.
    this.retryDelaysMs = options?.retryDelaysMs ?? (config.NODE_ENV === 'test' ? [5, 10, 20] : [500, 2_000, 5_000]);
  }

  async account(key: string): Promise<StripeAccount> {
    const a = obj(await this.request('GET', '/v1/account', key));
    const settings = obj(obj(a.settings).dashboard);
    return {
      id: str(a.id) ?? '',
      // *(verify)* the display name fields against the 2026-09-30 reference (T016).
      name: str(settings.display_name) ?? str(obj(a.business_profile).name),
      country: str(a.country),
      defaultCurrency: str(a.default_currency),
      chargesEnabled: a.charges_enabled === true,
      detailsSubmitted: a.details_submitted === true,
      currentlyDue: (Array.isArray(obj(a.requirements).currently_due) ? (obj(a.requirements).currently_due as unknown[]) : []).filter((x): x is string => typeof x === 'string'),
    };
  }

  async createCheckoutSession(key: string, input: CreateSessionInput): Promise<StripeSession> {
    const metadata = input.check ? { [PAYMENT_CHECK_METADATA_KEY]: '1' } : { [PAYMENT_REQUEST_METADATA_KEY]: input.requestId ?? '' };
    const description = input.reference ? `${input.description} · ${input.reference}` : input.description;
    const body = {
      mode: 'payment',
      line_items: [{ price_data: { currency: input.currency.toLowerCase(), unit_amount: input.amountMinor, product_data: { name: input.description } }, quantity: 1 }],
      client_reference_id: input.check ? undefined : (input.requestId ?? undefined),
      metadata,
      payment_intent_data: { metadata, description },
      expires_at: input.expiresAt,
      success_url: input.successUrl,
      locale: 'auto',
    };
    return toSession(await this.request('POST', '/v1/checkout/sessions', key, { form: body, idempotencyKey: input.idempotencyKey }));
  }

  async retrieveCheckoutSession(key: string, id: string): Promise<StripeSession> {
    return toSession(await this.request('GET', `/v1/checkout/sessions/${encodeURIComponent(id)}`, key));
  }

  /** Stripe answers 400 when the session is no longer open; the caller then reads it (contracts/stripe.md §3). */
  async expireCheckoutSession(key: string, id: string, idempotencyKey: string): Promise<StripeSession> {
    return toSession(await this.request('POST', `/v1/checkout/sessions/${encodeURIComponent(id)}/expire`, key, { form: {}, idempotencyKey }));
  }

  async createWebhookEndpoint(key: string, input: { url: string; idempotencyKey: string }): Promise<{ id: string; secret: string | null; url: string }> {
    const e = obj(
      await this.request('POST', '/v1/webhook_endpoints', key, {
        form: { url: input.url, api_version: this.version, description: 'WhatsApp platform payments', enabled_events: [...STRIPE_WEBHOOK_EVENTS], metadata: { wbm: '1' } },
        idempotencyKey: input.idempotencyKey,
      }),
    );
    return { id: str(e.id) ?? '', secret: str(e.secret), url: str(e.url) ?? input.url };
  }

  async deleteWebhookEndpoint(key: string, id: string): Promise<void> {
    try {
      await this.request('DELETE', `/v1/webhook_endpoints/${encodeURIComponent(id)}`, key);
    } catch (error) {
      if (!(error instanceof StripeApiError && error.status === 404)) throw error;
    }
  }

  async listEvents(key: string, input: { createdAfter: number; types?: readonly string[]; startingAfter?: string; limit?: number }): Promise<{ data: unknown[]; hasMore: boolean }> {
    const query = new URLSearchParams();
    for (const type of input.types ?? STRIPE_WEBHOOK_EVENTS) query.append('types[]', type);
    query.set('created[gt]', String(input.createdAfter));
    query.set('limit', String(input.limit ?? 100));
    if (input.startingAfter) query.set('starting_after', input.startingAfter);
    const list = obj(await this.request('GET', `/v1/events?${query.toString()}`, key));
    return { data: Array.isArray(list.data) ? list.data : [], hasMore: list.has_more === true };
  }

  private async request(method: 'GET' | 'POST' | 'DELETE', path: string, key: string, opts: { form?: Obj; idempotencyKey?: string } = {}): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${key}`, 'stripe-version': this.version };
    if (opts.form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;
    const body = opts.form !== undefined ? encodeStripeForm(opts.form) : undefined;
    for (let attempt = 0; ; attempt += 1) {
      const last = attempt >= this.retryDelaysMs.length;
      let res: Response;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        res = await fetch(`${this.baseUrl}${path}`, { method, headers, body, signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        if (last) throw new StripeNetworkError(`Stripe request failed (${(error as { code?: string })?.code ?? 'timeout or connection reset'})`, error);
        await this.wait(attempt);
        continue;
      }
      clearTimeout(timer);
      const text = await res.text();
      let parsed: unknown = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }
      if (res.ok) return parsed;
      if ((res.status === 429 || res.status >= 500) && !last) {
        await this.wait(attempt);
        continue;
      }
      const error = obj(obj(parsed).error);
      throw new StripeApiError(res.status, str(error.type), str(error.code), str(error.decline_code), str(error.param), str(error.message) ?? `Stripe answered ${res.status}`);
    }
  }

  private wait(attempt: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, this.retryDelaysMs[attempt] ?? 0));
  }
}
