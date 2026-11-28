import { Inject, Injectable, Optional } from '@nestjs/common';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import type { MetaTemplateComponent } from '@wbm/shared';

/** Graph API error response (HTTP non-2xx). */
export class MetaApiError extends Error {
  constructor(
    readonly httpStatus: number,
    readonly code: number | undefined,
    readonly subcode: number | undefined,
    message: string,
    readonly fbtraceId?: string,
  ) {
    super(message);
    this.name = 'MetaApiError';
  }
}

/**
 * Transport failure. `pre_send` = the request never reached Meta (safe to retry);
 * `ambiguous` = it may have been processed (never retried, research R7).
 */
export class MetaNetworkError extends Error {
  constructor(
    readonly phase: 'pre_send' | 'ambiguous',
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MetaNetworkError';
  }
}

export interface TemplateMessagePayload {
  to: string;
  template: {
    name: string;
    language: { code: string };
    components: Array<Record<string, unknown>>;
  };
}

export interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  parameter_format?: string;
  rejected_reason?: string;
  components: MetaTemplateComponent[];
  message_send_ttl_seconds?: number;
}

export interface CreateTemplateBody {
  name: string;
  language: string;
  category: string;
  components: Array<Record<string, unknown>>;
  parameter_format?: 'POSITIONAL' | 'NAMED';
  /** Feature 009 (research R8): authentication 30–900 s, utility 30–43200 s. */
  message_send_ttl_seconds?: number;
}

/**
 * A free-form message inside the 24-hour window (002 contracts/meta-graph-inbox.md §2), including
 * the reply buttons and lists that chatbot flows send (003 contracts/meta-graph-flows.md).
 */
export type SessionMessagePayload =
  | { to: string; type: 'text'; text: { body: string; preview_url: boolean } }
  | { to: string; type: 'image' | 'video' | 'document'; media: { id?: string; link?: string; caption?: string; filename?: string } }
  | { to: string; type: 'audio'; media: { id?: string; link?: string } }
  | { to: string; type: 'interactive'; interactive: Record<string, unknown> };

/** Metadata of media a customer sent (§3); the URL is short-lived and needs the same token. */
export interface MediaInfo {
  url: string;
  mimeType: string | undefined;
  fileSize: number | undefined;
  sha256: string | undefined;
}

export class MediaTooLargeError extends Error {
  constructor(readonly sizeBytes: number, readonly maxBytes: number) {
    super(`Media is ${sizeBytes} bytes; the limit is ${maxBytes}`);
    this.name = 'MediaTooLargeError';
  }
}

export interface PhoneNumberInfo {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string;
  qualityRating: string | undefined;
  status: string | undefined;
  throughputLevel: string | undefined;
  /** Feature 010 (R11): `whatsapp_business_manager_messaging_limit`, shared by the business portfolio. */
  messagingLimit?: string | undefined;
}

/** Feature 010 (US7): the WhatsApp Business profile as Meta holds it. */
export interface BusinessProfileInfo {
  about?: string;
  address?: string;
  description?: string;
  email?: string;
  profile_picture_url?: string;
  websites?: string[];
  vertical?: string;
}

/** Feature 010 (US7): the display name status, quality and messaging limit of a number. */
export interface NumberStatusInfo {
  verifiedName: string | null;
  nameStatus: string | null;
  newNameStatus: string | null;
  qualityRating: string | null;
  messagingLimit: string | null;
}

const limitText = (limit: string | { tier?: string } | undefined): string | undefined => (typeof limit === 'string' ? limit : limit?.tier);

/** GET /debug_token (feature 006 US8, research R13). `expiresAt` 0 means the token never expires. */
export interface TokenDebugInfo {
  isValid: boolean;
  appId: string | null;
  type: string | null;
  expiresAt: number | null;
  scopes: string[];
  granularScopes: Array<{ scope: string; targetIds: string[] }>;
  error: string | null;
}

export interface WabaInfo {
  id: string;
  name: string;
  currency: string | null;
  timezoneId: string | null;
}

/** A number with the fields the wizard checks (research R13). */
export interface WizardPhoneNumber {
  id: string;
  displayPhoneNumber: string;
  verifiedName: string | null;
  nameStatus: string | null;
  status: string | null;
  codeVerificationStatus: string | null;
  qualityRating: string | null;
  platformType: string | null;
  throughputLevel: string | null;
  /** whatsapp_business_manager_messaging_limit (portfolio limits since 2025-10-07). */
  messagingLimit: string | null;
}

export interface AppSubscription {
  object: string;
  callbackUrl: string | null;
  active: boolean;
  fields: string[];
}

const WIZARD_PHONE_FIELDS =
  'id,display_phone_number,verified_name,name_status,status,code_verification_status,quality_rating,platform_type,throughput,whatsapp_business_manager_messaging_limit';

interface RawWizardPhone {
  id: string;
  display_phone_number?: string;
  verified_name?: string;
  name_status?: string;
  status?: string;
  code_verification_status?: string;
  quality_rating?: string;
  platform_type?: string;
  throughput?: { level?: string };
  whatsapp_business_manager_messaging_limit?: string | { tier?: string };
}

function toWizardPhone(p: RawWizardPhone): WizardPhoneNumber {
  const limit = p.whatsapp_business_manager_messaging_limit;
  return {
    id: p.id,
    displayPhoneNumber: p.display_phone_number ?? '',
    verifiedName: p.verified_name ?? null,
    nameStatus: p.name_status ?? null,
    status: p.status ?? null,
    codeVerificationStatus: p.code_verification_status ?? null,
    qualityRating: p.quality_rating ?? null,
    platformType: p.platform_type ?? null,
    throughputLevel: p.throughput?.level ?? null,
    messagingLimit: typeof limit === 'string' ? limit : (limit?.tier ?? null),
  };
}

const PRE_SEND_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'EHOSTUNREACH', 'ENETUNREACH']);

function errorCode(error: unknown, depth = 0): string | undefined {
  if (!error || typeof error !== 'object' || depth > 3) return undefined;
  const e = error as { code?: unknown; cause?: unknown; message?: unknown };
  if (typeof e.code === 'string') return e.code;
  const fromCause = errorCode(e.cause, depth + 1);
  if (fromCause) return fromCause;
  if (typeof e.message === 'string') return [...PRE_SEND_CODES].find((c) => (e.message as string).includes(c));
  return undefined;
}

export function toNetworkError(error: unknown): MetaNetworkError {
  const code = errorCode(error);
  const phase = code && PRE_SEND_CODES.has(code) ? 'pre_send' : 'ambiguous';
  return new MetaNetworkError(phase, `Graph API request failed (${code ?? 'timeout or connection reset'})`, error);
}

/** Thin typed Graph API client (research R8, ADR-0002). One instance serves every number. */
@Injectable()
export class MetaGraphClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Optional() @Inject('META_CLIENT_OPTIONS') options?: { timeoutMs?: number },
  ) {
    this.baseUrl = `${config.META_GRAPH_BASE_URL.replace(/\/$/, '')}/${config.META_GRAPH_API_VERSION}`;
    this.timeoutMs = options?.timeoutMs ?? 10_000;
  }

  async sendTemplate(token: string, phoneNumberId: string, payload: TemplateMessagePayload): Promise<{ waMessageId: string }> {
    const body = await this.request<{ messages?: Array<{ id: string }> }>('POST', `/${phoneNumberId}/messages`, token, {
      json: { messaging_product: 'whatsapp', recipient_type: 'individual', type: 'template', ...payload },
    });
    const id = body.messages?.[0]?.id;
    if (!id) throw new MetaApiError(200, undefined, undefined, 'Graph API response has no message id');
    return { waMessageId: id };
  }

  async listTemplates(token: string, wabaId: string, after?: string): Promise<{ data: MetaTemplate[]; after?: string; hasNext: boolean }> {
    const body = await this.request<{ data: MetaTemplate[]; paging?: { cursors?: { after?: string }; next?: string } }>(
      'GET',
      `/${wabaId}/message_templates`,
      token,
      { query: { limit: '100', ...(after ? { after } : {}) } },
    );
    const nextAfter = body.paging?.cursors?.after;
    return { data: body.data ?? [], ...(nextAfter ? { after: nextAfter } : {}), hasNext: Boolean(body.paging?.next) };
  }

  async listAllTemplates(token: string, wabaId: string): Promise<MetaTemplate[]> {
    const all: MetaTemplate[] = [];
    let after: string | undefined;
    for (let page = 0; page < 100; page++) {
      const result = await this.listTemplates(token, wabaId, after);
      all.push(...result.data);
      if (!result.hasNext || !result.after) break;
      after = result.after;
    }
    return all;
  }

  createTemplate(token: string, wabaId: string, body: CreateTemplateBody): Promise<{ id: string; status: string; category: string }> {
    return this.request('POST', `/${wabaId}/message_templates`, token, { json: body });
  }

  /** Deletes one template; with `hsmId` only that language version is removed (otherwise all languages). */
  async deleteTemplate(token: string, wabaId: string, name: string, hsmId?: string): Promise<void> {
    await this.request('DELETE', `/${wabaId}/message_templates`, token, { query: { name, ...(hsmId ? { hsm_id: hsmId } : {}) } });
  }

  /** Resumable Upload API step 1: `POST /{app-id}/uploads` -> `{ id: "upload:<session>" }`. */
  async createUploadSession(token: string, appId: string, file: { name: string; length: number; type: string }): Promise<string> {
    const body = await this.request<{ id?: string }>('POST', `/${appId}/uploads`, token, {
      query: { file_name: file.name, file_length: String(file.length), file_type: file.type },
    });
    if (!body.id) throw new MetaApiError(200, undefined, undefined, 'Upload session response has no id');
    return body.id;
  }

  /**
   * Resumable Upload API step 2: `POST /upload:<session>` with the bytes, `file_offset: 0` and the
   * token as `Authorization: OAuth` (Meta rejects it as a query parameter) -> `{ h: "<handle>" }`.
   */
  async uploadSessionData(token: string, sessionId: string, data: Buffer): Promise<string> {
    const body = await this.request<{ h?: string }>('POST', `/${sessionId}`, token, {
      raw: data,
      headers: { authorization: `OAuth ${token}`, file_offset: '0' },
    });
    if (!body.h) throw new MetaApiError(200, undefined, undefined, 'Upload response has no file handle');
    return body.h;
  }

  async getPhoneNumber(token: string, phoneNumberId: string): Promise<PhoneNumberInfo> {
    const body = await this.request<{
      id: string;
      display_phone_number: string;
      verified_name: string;
      quality_rating?: string;
      status?: string;
      throughput?: { level?: string };
      whatsapp_business_manager_messaging_limit?: string | { tier?: string };
    }>('GET', `/${phoneNumberId}`, token, {
      query: { fields: 'id,display_phone_number,verified_name,quality_rating,code_verification_status,status,throughput,whatsapp_business_manager_messaging_limit' },
    });
    return {
      id: body.id,
      displayPhoneNumber: body.display_phone_number,
      verifiedName: body.verified_name,
      qualityRating: body.quality_rating,
      status: body.status,
      throughputLevel: body.throughput?.level,
      messagingLimit: limitText(body.whatsapp_business_manager_messaging_limit),
    };
  }

  /** Feature 010 (US7, contracts/meta-business-profile.md §1). */
  async getBusinessProfile(token: string, phoneNumberId: string): Promise<BusinessProfileInfo> {
    const body = await this.request<{ data?: BusinessProfileInfo[] }>('GET', `/${phoneNumberId}/whatsapp_business_profile`, token, {
      query: { fields: 'about,address,description,email,profile_picture_url,websites,vertical' },
    });
    return body.data?.[0] ?? {};
  }

  /** Feature 010 (US7, §2): only the given fields change; `messaging_product` is always sent. */
  async updateBusinessProfile(token: string, phoneNumberId: string, fields: Record<string, unknown>): Promise<void> {
    await this.request('POST', `/${phoneNumberId}/whatsapp_business_profile`, token, { json: { messaging_product: 'whatsapp', ...fields } });
  }

  /** Feature 010 (US7, §4): display name status, quality and the portfolio's messaging limit. */
  async getNumberStatus(token: string, phoneNumberId: string): Promise<NumberStatusInfo> {
    const body = await this.request<{
      verified_name?: string;
      name_status?: string;
      new_name_status?: string;
      quality_rating?: string;
      whatsapp_business_manager_messaging_limit?: string | { tier?: string };
    }>('GET', `/${phoneNumberId}`, token, { query: { fields: 'verified_name,name_status,new_name_status,quality_rating,whatsapp_business_manager_messaging_limit' } });
    return {
      verifiedName: body.verified_name ?? null,
      nameStatus: body.name_status ?? null,
      newNameStatus: body.new_name_status ?? null,
      qualityRating: body.quality_rating ?? null,
      messagingLimit: limitText(body.whatsapp_business_manager_messaging_limit) ?? null,
    };
  }

  /** Sends a free-form reply (text or media); returns the wamid. */
  async sendSessionMessage(token: string, phoneNumberId: string, payload: SessionMessagePayload): Promise<{ waMessageId: string }> {
    const content = payload.type === 'text' ? payload.text : payload.type === 'interactive' ? payload.interactive : payload.media;
    const body = await this.request<{ messages?: Array<{ id: string }> }>('POST', `/${phoneNumberId}/messages`, token, {
      json: { messaging_product: 'whatsapp', recipient_type: 'individual', to: payload.to, type: payload.type, [payload.type]: content },
    });
    const id = body.messages?.[0]?.id;
    if (!id) throw new MetaApiError(200, undefined, undefined, 'Graph API response has no message id');
    return { waMessageId: id };
  }

  /** Marks a customer message (and the conversation up to it) as read (§4). */
  async markRead(token: string, phoneNumberId: string, waMessageId: string): Promise<void> {
    await this.request('POST', `/${phoneNumberId}/messages`, token, {
      json: { messaging_product: 'whatsapp', status: 'read', message_id: waMessageId },
    });
  }

  /** Looks up media a customer sent (§3). */
  async getMedia(token: string, mediaId: string): Promise<MediaInfo> {
    const body = await this.request<{ url?: string; mime_type?: string; file_size?: number | string; sha256?: string }>('GET', `/${encodeURIComponent(mediaId)}`, token);
    if (!body.url) throw new MetaApiError(200, undefined, undefined, 'Graph API media response has no url');
    const size = body.file_size === undefined ? undefined : Number(body.file_size);
    return { url: body.url, mimeType: body.mime_type, fileSize: Number.isFinite(size) ? size : undefined, sha256: body.sha256 };
  }

  /**
   * Downloads media from the URL getMedia returned, with the same token. The token is only sent
   * over https or to the configured Graph origin (mock-meta in development). Stops at maxBytes.
   */
  async downloadMedia(token: string, url: string, maxBytes: number): Promise<Buffer> {
    const target = new URL(url);
    if (target.protocol !== 'https:' && target.origin !== new URL(this.baseUrl).origin) {
      throw new MetaApiError(0, undefined, undefined, `Refusing to send the token to ${target.origin}`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(this.timeoutMs, 60_000));
    try {
      let res: Response;
      try {
        res = await fetch(target, { headers: { authorization: `Bearer ${token}` }, signal: controller.signal });
      } catch (error) {
        throw toNetworkError(error);
      }
      if (!res.ok) throw new MetaApiError(res.status, undefined, undefined, `Media download failed with HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > maxBytes) throw new MediaTooLargeError(declared, maxBytes);
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of res.body ?? []) {
        total += (chunk as Uint8Array).byteLength;
        if (total > maxBytes) {
          controller.abort();
          throw new MediaTooLargeError(total, maxBytes);
        }
        chunks.push(Buffer.from(chunk as Uint8Array));
      }
      return Buffer.concat(chunks);
    } finally {
      clearTimeout(timer);
    }
  }

  uploadMedia(token: string, phoneNumberId: string, file: Buffer, mimeType: string, filename: string): Promise<{ id: string }> {
    const form = new FormData();
    form.set('messaging_product', 'whatsapp');
    form.set('type', mimeType);
    form.set('file', new Blob([new Uint8Array(file)], { type: mimeType }), filename);
    return this.request('POST', `/${phoneNumberId}/media`, token, { form });
  }

  // ---------- Number connection wizard (feature 006 US8, research R13) ----------

  /** Inspects a pasted token; `authToken` is the app token "{app-id}|{app-secret}" when the app id is set. */
  async debugToken(inputToken: string, authToken: string): Promise<TokenDebugInfo> {
    const body = await this.request<{
      data?: {
        is_valid?: boolean;
        app_id?: string;
        type?: string;
        expires_at?: number;
        scopes?: string[];
        granular_scopes?: Array<{ scope: string; target_ids?: string[] }>;
        error?: { message?: string };
      };
    }>('GET', '/debug_token', authToken, { query: { input_token: inputToken } });
    const d = body.data ?? {};
    return {
      isValid: d.is_valid === true,
      appId: d.app_id ?? null,
      type: d.type ?? null,
      expiresAt: typeof d.expires_at === 'number' ? d.expires_at : null,
      scopes: d.scopes ?? [],
      granularScopes: (d.granular_scopes ?? []).map((g) => ({ scope: g.scope, targetIds: g.target_ids ?? [] })),
      error: d.error?.message ?? null,
    };
  }

  /** The WhatsApp accounts a token reaches: their ids come from its granular scopes (debugToken). */
  async listWabas(token: string, wabaIds: readonly string[]): Promise<WabaInfo[]> {
    const accounts: WabaInfo[] = [];
    for (const id of wabaIds) {
      const body = await this.request<{ id: string; name?: string; currency?: string; timezone_id?: string }>('GET', `/${id}`, token, {
        query: { fields: 'name,currency,timezone_id' },
      });
      accounts.push({ id: body.id ?? id, name: body.name ?? id, currency: body.currency ?? null, timezoneId: body.timezone_id ?? null });
    }
    return accounts;
  }

  async listPhoneNumbers(token: string, wabaId: string): Promise<WizardPhoneNumber[]> {
    const body = await this.request<{ data?: RawWizardPhone[] }>('GET', `/${wabaId}/phone_numbers`, token, { query: { fields: WIZARD_PHONE_FIELDS, limit: '100' } });
    return (body.data ?? []).map(toWizardPhone);
  }

  async phoneNumberDetails(token: string, phoneNumberId: string): Promise<WizardPhoneNumber> {
    return toWizardPhone(await this.request<RawWizardPhone>('GET', `/${phoneNumberId}`, token, { query: { fields: WIZARD_PHONE_FIELDS } }));
  }

  /** Registers the number for the Cloud API with its two-step verification PIN. */
  async registerNumber(token: string, phoneNumberId: string, pin: string): Promise<void> {
    await this.request('POST', `/${phoneNumberId}/register`, token, { json: { messaging_product: 'whatsapp', pin } });
  }

  /** The apps that get the account's webhooks. */
  async getSubscribedApps(token: string, wabaId: string): Promise<Array<{ id: string; name: string | null }>> {
    const body = await this.request<{ data?: Array<{ whatsapp_business_api_data?: { id?: string; name?: string }; id?: string; name?: string }> }>('GET', `/${wabaId}/subscribed_apps`, token);
    return (body.data ?? []).map((a) => ({ id: a.whatsapp_business_api_data?.id ?? a.id ?? '', name: a.whatsapp_business_api_data?.name ?? a.name ?? null })).filter((a) => a.id);
  }

  /** Subscribes the app that owns the token to the account's webhooks. */
  async subscribeApp(token: string, wabaId: string): Promise<void> {
    await this.request('POST', `/${wabaId}/subscribed_apps`, token);
  }

  /** The app's webhook settings (callback URL and fields), read with the app token. */
  async getAppSubscriptions(appToken: string, appId: string): Promise<AppSubscription[]> {
    const body = await this.request<{ data?: Array<{ object?: string; callback_url?: string; active?: boolean; fields?: Array<{ name?: string } | string> }> }>(
      'GET',
      `/${appId}/subscriptions`,
      appToken,
    );
    return (body.data ?? []).map((sub) => ({
      object: sub.object ?? '',
      callbackUrl: sub.callback_url ?? null,
      active: sub.active !== false,
      fields: (sub.fields ?? []).map((f) => (typeof f === 'string' ? f : (f.name ?? ''))).filter(Boolean),
    }));
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string,
    opts: { query?: Record<string, string>; json?: unknown; form?: FormData; raw?: Buffer; headers?: Record<string, string> } = {},
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(opts.raw ? { 'content-type': 'application/octet-stream' } : {}),
          ...opts.headers,
        },
        ...(opts.json !== undefined
          ? { body: JSON.stringify(opts.json) }
          : opts.form
            ? { body: opts.form }
            : opts.raw
              ? { body: new Uint8Array(opts.raw) }
              : {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw toNetworkError(error);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    if (!res.ok) {
      const e = (body as { error?: { code?: number; error_subcode?: number; message?: string; error_user_msg?: string; fbtrace_id?: string } }).error;
      // error_user_msg is Meta's human-readable explanation (e.g. why a template was refused).
      throw new MetaApiError(res.status, e?.code, e?.error_subcode, e?.error_user_msg ?? e?.message ?? `Graph API HTTP ${res.status}`, e?.fbtrace_id);
    }
    return body as T;
  }
}
