import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { toMinor } from '@wbm/shared';
import { APP_CONFIG } from '../../common/config/config.module.js';
import type { AppConfig } from '../../common/config/config.js';
import { MetaApiError, toNetworkError } from '../meta/meta-graph.client.js';

// The Meta Marketing API calls of feature 007 (contracts/meta-ads-graph.md, research R1): one thin
// client on the pinned Graph version, with the 001 error rules. Fields that Meta's documentation
// gives in more than one form are read in both forms.

export interface AdAccountInfo {
  id: string;
  name: string;
  accountStatus: number;
  disableReason: number | null;
  currency: string;
  timezone: string;
  hasPaymentMethod: boolean;
  /** The custom audience terms; null when Meta does not say. */
  audienceTermsAccepted: boolean | null;
}

export interface PageInfo {
  id: string;
  name: string;
  tasks: string[];
  accessToken: string | null;
}

export interface PageAdsFacts {
  leadTermsAccepted: boolean | null;
  /** Null when Meta does not let the token read the linked numbers. */
  whatsappNumbers: string[] | null;
}

export interface TargetingResult {
  key: string;
  name: string;
  type: string;
  countryCode: string | null;
  audienceLower: number | null;
  audienceUpper: number | null;
}

export interface AdState {
  id: string;
  effectiveStatus: string;
  feedback: string | null;
}

export interface InsightRow {
  adId: string | null;
  date: string;
  impressions: number;
  reach: number;
  clicks: number;
  spendMinor: number;
  conversations: number;
  leads: number;
}

export interface MetaLead {
  id: string;
  createdTime: string;
  adId: string | null;
  formId: string | null;
  fields: Record<string, string>;
  /** Answers to the form's checkboxes: id → ticked. */
  disclaimers: Record<string, boolean>;
}

export interface LeadFormSpec {
  name: string;
  questions: Array<{ type: string; key?: string; label?: string }>;
  privacyUrl: string;
  privacyText: string;
  consentText: string;
}

const CONVERSATION_ACTION = 'onsite_conversion.messaging_conversation_started_7d';
const LEAD_ACTIONS = new Set(['lead', 'onsite_conversion.lead_grouped', 'leadgen_grouped']);
const num = (value: unknown): number => {
  const n = typeof value === 'number' ? value : Number(value ?? 0);
  return Number.isFinite(n) ? n : 0;
};

@Injectable()
export class MetaAdsClient {
  private readonly logger = new Logger(MetaAdsClient.name);
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  /** Highest business use case usage seen in the last answer, in percent. */
  private usage = 0;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Optional() @Inject('META_ADS_CLIENT_OPTIONS') options?: { timeoutMs?: number },
  ) {
    this.baseUrl = `${config.META_GRAPH_BASE_URL.replace(/\/$/, '')}/${config.META_GRAPH_API_VERSION}`;
    this.timeoutMs = options?.timeoutMs ?? 20_000;
  }

  /** Syncs skip a round while Meta's usage for the account is above 75% (R1). */
  busy(): boolean {
    return this.usage > 75;
  }

  // ---------- Connection (R2) ----------

  async adAccounts(token: string): Promise<AdAccountInfo[]> {
    const body = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', '/me/adaccounts', token, {
      query: { fields: 'account_id,name,account_status,disable_reason,currency,timezone_name,funding_source_details', limit: '50' },
    });
    return (body.data ?? []).map((a) => this.toAccount(a));
  }

  async adAccount(token: string, accountId: string): Promise<AdAccountInfo> {
    const a = await this.request<Record<string, unknown>>('GET', `/act_${accountId}`, token, {
      query: { fields: 'account_id,name,account_status,disable_reason,currency,timezone_name,funding_source_details,tos_accepted' },
    });
    return this.toAccount(a);
  }

  async pages(token: string): Promise<PageInfo[]> {
    const body = await this.request<{ data?: Array<{ id: string; name?: string; tasks?: string[]; access_token?: string }> }>('GET', '/me/accounts', token, {
      query: { fields: 'id,name,tasks,access_token', limit: '100' },
    });
    return (body.data ?? []).map((p) => ({ id: p.id, name: p.name ?? p.id, tasks: p.tasks ?? [], accessToken: p.access_token ?? null }));
  }

  /** The lead terms and the linked WhatsApp number; the number field is read only where Meta allows it. */
  async pageAdsFacts(token: string, pageId: string): Promise<PageAdsFacts> {
    try {
      const page = await this.request<{ leadgen_tos_accepted?: boolean; whatsapp_number?: string }>('GET', `/${pageId}`, token, { query: { fields: 'leadgen_tos_accepted,whatsapp_number' } });
      return { leadTermsAccepted: typeof page.leadgen_tos_accepted === 'boolean' ? page.leadgen_tos_accepted : null, whatsappNumbers: page.whatsapp_number ? [page.whatsapp_number] : [] };
    } catch (error) {
      if (!(error instanceof MetaApiError) || error.code !== 100) throw error;
      const page = await this.request<{ leadgen_tos_accepted?: boolean }>('GET', `/${pageId}`, token, { query: { fields: 'leadgen_tos_accepted' } });
      return { leadTermsAccepted: typeof page.leadgen_tos_accepted === 'boolean' ? page.leadgen_tos_accepted : null, whatsappNumbers: null };
    }
  }

  // ---------- Building (R3–R5) ----------

  async searchLocations(token: string, q: string): Promise<TargetingResult[]> {
    const body = await this.request<{ data?: Array<{ key: string; name: string; type: string; country_code?: string }> }>('GET', '/search', token, {
      query: { type: 'adgeolocation', q, location_types: JSON.stringify(['country', 'region', 'city']), limit: '20' },
    });
    return (body.data ?? []).map((l) => ({ key: String(l.key), name: l.name, type: l.type, countryCode: l.country_code ?? null, audienceLower: null, audienceUpper: null }));
  }

  async searchInterests(token: string, q: string): Promise<TargetingResult[]> {
    const body = await this.request<{ data?: Array<{ id: string; name: string; audience_size_lower_bound?: number; audience_size_upper_bound?: number }> }>('GET', '/search', token, {
      query: { type: 'adinterest', q, limit: '20' },
    });
    return (body.data ?? []).map((i) => ({
      key: String(i.id),
      name: i.name,
      type: 'interest',
      countryCode: null,
      audienceLower: i.audience_size_lower_bound ?? null,
      audienceUpper: i.audience_size_upper_bound ?? null,
    }));
  }

  /** Meta's audience range for a targeting spec; nulls when Meta cannot estimate it. */
  async deliveryEstimate(token: string, accountId: string, targeting: Record<string, unknown>, optimizationGoal: string): Promise<{ lower: number | null; upper: number | null }> {
    const body = await this.request<{ data?: Array<{ estimate_mau_lower_bound?: number; estimate_mau_upper_bound?: number; estimate_mau?: number }> }>(
      'GET',
      `/act_${accountId}/delivery_estimate`,
      token,
      { query: { targeting_spec: JSON.stringify(targeting), optimization_goal: optimizationGoal } },
    );
    const e = body.data?.[0];
    const lower = e?.estimate_mau_lower_bound ?? e?.estimate_mau ?? null;
    const upper = e?.estimate_mau_upper_bound ?? e?.estimate_mau ?? null;
    return { lower: lower !== null && lower >= 0 ? lower : null, upper: upper !== null && upper >= 0 ? upper : null };
  }

  /** Meta's minimum daily budget for impression-billed ad sets, in the account currency's minor units. */
  async minimumDailyBudget(token: string, accountId: string): Promise<{ currency: string; minDailyBudgetMinor: number }> {
    const body = await this.request<{ data?: Array<{ currency: string; min_daily_budget_imp?: number | string }> }>('GET', `/act_${accountId}/minimum_budgets`, token);
    const row = body.data?.[0];
    if (!row) throw new MetaApiError(200, undefined, undefined, 'Meta returned no minimum budget');
    return { currency: row.currency, minDailyBudgetMinor: num(row.min_daily_budget_imp) };
  }

  async uploadImage(token: string, accountId: string, bytes: Buffer, filename: string, mimeType: string): Promise<string> {
    const form = new FormData();
    form.set('filename', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    const body = await this.request<{ images?: Record<string, { hash?: string }> }>('POST', `/act_${accountId}/adimages`, token, { form });
    const hash = Object.values(body.images ?? {})[0]?.hash;
    if (!hash) throw new MetaApiError(200, undefined, undefined, 'Meta returned no image hash');
    return hash;
  }

  async uploadVideo(token: string, accountId: string, bytes: Buffer, filename: string, mimeType: string): Promise<string> {
    const form = new FormData();
    form.set('source', new Blob([new Uint8Array(bytes)], { type: mimeType }), filename);
    const body = await this.request<{ id?: string }>('POST', `/act_${accountId}/advideos`, token, { form });
    if (!body.id) throw new MetaApiError(200, undefined, undefined, 'Meta returned no video id');
    return body.id;
  }

  async videoStatus(token: string, videoId: string): Promise<'ready' | 'processing' | 'error'> {
    const body = await this.request<{ status?: { video_status?: string } }>('GET', `/${videoId}`, token, { query: { fields: 'status' } });
    const s = body.status?.video_status;
    return s === 'ready' ? 'ready' : s === 'error' ? 'error' : 'processing';
  }

  /** A WhatsApp welcome message sequence carrying the pre-filled message (R4). */
  async createWelcomeSequence(token: string, wabaId: string, name: string, prefilledMessage: string): Promise<string> {
    const body = await this.request<{ sequence_id?: string; id?: string }>('POST', `/${wabaId}/welcome_message_sequences`, token, {
      json: { name, welcome_message_sequence: JSON.stringify({ text: prefilledMessage, autofill_message: { content: prefilledMessage } }) },
    });
    const id = body.sequence_id ?? body.id;
    if (!id) throw new MetaApiError(200, undefined, undefined, 'Meta returned no welcome message sequence id');
    return id;
  }

  async create(token: string, accountId: string, edge: 'adcreatives' | 'campaigns' | 'adsets' | 'ads', fields: Record<string, unknown>): Promise<string> {
    const body = await this.request<{ id?: string }>('POST', `/act_${accountId}/${edge}`, token, { json: fields });
    if (!body.id) throw new MetaApiError(200, undefined, undefined, `Meta returned no id for the new ${edge}`);
    return body.id;
  }

  async update(token: string, objectId: string, fields: Record<string, unknown>): Promise<void> {
    await this.request('POST', `/${objectId}`, token, { json: fields });
  }

  async deleteObject(token: string, objectId: string): Promise<void> {
    await this.request('DELETE', `/${objectId}`, token);
  }

  // ---------- Running (R6, R7) ----------

  async objectStatus(token: string, objectId: string): Promise<{ effectiveStatus: string; configuredStatus: string | null }> {
    const body = await this.request<{ effective_status?: string; configured_status?: string; status?: string }>('GET', `/${objectId}`, token, {
      query: { fields: 'effective_status,configured_status' },
    });
    return { effectiveStatus: body.effective_status ?? body.status ?? 'UNKNOWN', configuredStatus: body.configured_status ?? null };
  }

  async adsOf(token: string, adsetId: string): Promise<AdState[]> {
    const body = await this.request<{ data?: Array<{ id: string; effective_status?: string; ad_review_feedback?: unknown; review_feedback?: unknown }> }>(
      'GET',
      `/${adsetId}/ads`,
      token,
      { query: { fields: 'id,effective_status,ad_review_feedback', limit: '50' } },
    );
    return (body.data ?? []).map((a) => ({ id: a.id, effectiveStatus: a.effective_status ?? 'UNKNOWN', feedback: feedbackText(a.ad_review_feedback ?? a.review_feedback) }));
  }

  /** Daily numbers between two dates (inclusive) of a campaign, per ad or for the campaign itself. */
  async insights(token: string, campaignId: string, range: { since: string; until: string }, currency: string, level: 'ad' | 'campaign'): Promise<InsightRow[]> {
    const rows: InsightRow[] = [];
    let path: string | null = `/${campaignId}/insights`;
    let query: Record<string, string> | undefined = {
      level,
      time_increment: '1',
      time_range: JSON.stringify(range),
      fields: level === 'ad' ? 'ad_id,impressions,reach,clicks,spend,actions' : 'impressions,reach,clicks,spend,actions',
      limit: '500',
    };
    for (let page = 0; path && page < 20; page += 1) {
      const body: { data?: Array<Record<string, unknown>>; paging?: { next?: string } } = await this.request('GET', path, token, query ? { query } : {});
      for (const r of body.data ?? []) {
        const actions = (Array.isArray(r.actions) ? r.actions : []) as Array<{ action_type?: string; value?: string | number }>;
        rows.push({
          adId: typeof r.ad_id === 'string' ? r.ad_id : null,
          date: String(r.date_start ?? ''),
          impressions: num(r.impressions),
          reach: num(r.reach),
          clicks: num(r.clicks),
          spendMinor: toMinor(num(r.spend), currency),
          conversations: actions.filter((a) => a.action_type === CONVERSATION_ACTION).reduce((s, a) => s + num(a.value), 0),
          leads: actions.filter((a) => LEAD_ACTIONS.has(a.action_type ?? '')).reduce((s, a) => s + num(a.value), 0),
        });
      }
      const next = body.paging?.next;
      path = next ? next.replace(this.baseUrl, '').replace(/^https?:\/\/[^/]+\/v\d+\.\d+/, '') : null;
      query = undefined;
    }
    return rows;
  }

  // ---------- Audiences (R8) ----------

  async createCustomAudience(token: string, accountId: string, name: string): Promise<string> {
    return this.create2(token, `/act_${accountId}/customaudiences`, { name, subtype: 'CUSTOM', customer_file_source: 'USER_PROVIDED_ONLY', description: 'Made by the company WhatsApp platform' });
  }

  async createLookalike(token: string, accountId: string, input: { name: string; originAudienceId: string; country: string; ratio: number }): Promise<string> {
    return this.create2(token, `/act_${accountId}/customaudiences`, {
      name: input.name,
      subtype: 'LOOKALIKE',
      origin_audience_id: input.originAudienceId,
      lookalike_spec: JSON.stringify({ country: input.country, ratio: input.ratio }),
    });
  }

  async addAudienceUsers(token: string, audienceId: string, hashes: readonly string[]): Promise<void> {
    await this.request('POST', `/${audienceId}/users`, token, { json: { payload: { schema: 'PHONE_SHA256', data: hashes } } });
  }

  async removeAudienceUsers(token: string, audienceId: string, hashes: readonly string[]): Promise<void> {
    await this.request('DELETE', `/${audienceId}/users`, token, { json: { payload: { schema: 'PHONE_SHA256', data: hashes } } });
  }

  async audienceSize(token: string, audienceId: string): Promise<number | null> {
    const body = await this.request<{ approximate_count_lower_bound?: number; approximate_count?: number }>('GET', `/${audienceId}`, token, {
      query: { fields: 'approximate_count_lower_bound' },
    });
    const n = body.approximate_count_lower_bound ?? body.approximate_count;
    return typeof n === 'number' && n >= 0 ? n : null;
  }

  // ---------- Lead forms (R9) ----------

  async createLeadForm(pageToken: string, pageId: string, form: LeadFormSpec): Promise<string> {
    return this.create2(pageToken, `/${pageId}/leadgen_forms`, {
      name: form.name,
      questions: JSON.stringify(form.questions),
      privacy_policy: JSON.stringify({ url: form.privacyUrl, link_text: form.privacyText }),
      legal_content: JSON.stringify({ custom_disclaimer: { checkboxes: [{ key: 'whatsapp_consent', text: form.consentText, is_required: false, is_checked_by_default: false }] } }),
    });
  }

  async subscribePageToLeads(pageToken: string, pageId: string): Promise<void> {
    await this.request('POST', `/${pageId}/subscribed_apps`, pageToken, { json: { subscribed_fields: 'leadgen' } });
  }

  async lead(token: string, leadId: string): Promise<MetaLead> {
    return toLead(
      await this.request<Record<string, unknown>>('GET', `/${leadId}`, token, { query: { fields: 'id,created_time,ad_id,form_id,field_data,custom_disclaimer_responses' } }),
    );
  }

  async formLeads(token: string, formId: string, sinceUnix: number): Promise<MetaLead[]> {
    const body = await this.request<{ data?: Array<Record<string, unknown>> }>('GET', `/${formId}/leads`, token, {
      query: {
        fields: 'id,created_time,ad_id,form_id,field_data,custom_disclaimer_responses',
        filtering: JSON.stringify([{ field: 'time_created', operator: 'GREATER_THAN', value: sinceUnix }]),
        limit: '200',
      },
    });
    return (body.data ?? []).map(toLead);
  }

  // ---------- Internals ----------

  private toAccount(a: Record<string, unknown>): AdAccountInfo {
    const tos = (a.tos_accepted ?? null) as Record<string, unknown> | null;
    const funding = a.funding_source_details as { id?: unknown } | undefined;
    return {
      id: String(a.account_id ?? String(a.id ?? '').replace(/^act_/, '')),
      name: String(a.name ?? a.account_id ?? ''),
      accountStatus: num(a.account_status),
      disableReason: a.disable_reason === undefined || a.disable_reason === null || num(a.disable_reason) === 0 ? null : num(a.disable_reason),
      currency: String(a.currency ?? 'USD'),
      timezone: String(a.timezone_name ?? 'UTC'),
      hasPaymentMethod: Boolean(funding && funding.id),
      audienceTermsAccepted: tos ? num(tos.custom_audience_tos) === 1 : null,
    };
  }

  private async create2(token: string, path: string, fields: Record<string, unknown>): Promise<string> {
    const body = await this.request<{ id?: string }>('POST', path, token, { json: fields });
    if (!body.id) throw new MetaApiError(200, undefined, undefined, 'Meta returned no id');
    return body.id;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    token: string,
    opts: { query?: Record<string, string>; json?: unknown; form?: FormData } = {},
  ): Promise<T> {
    const url = new URL(path.startsWith('http') ? path : `${this.baseUrl}${path}`);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(opts.json !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(opts.json !== undefined ? { body: JSON.stringify(opts.json) } : opts.form ? { body: opts.form } : {}),
        signal: controller.signal,
      });
    } catch (error) {
      throw toNetworkError(error);
    } finally {
      clearTimeout(timer);
    }
    this.readUsage(res.headers.get('x-business-use-case-usage'));
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
      throw new MetaApiError(res.status, e?.code, e?.error_subcode, e?.error_user_msg ?? e?.message ?? `Graph API HTTP ${res.status}`, e?.fbtrace_id);
    }
    return body as T;
  }

  private readUsage(header: string | null): void {
    if (!header) return;
    try {
      const parsed = JSON.parse(header) as Record<string, Array<{ call_count?: number; total_cputime?: number; total_time?: number }>>;
      const values = Object.values(parsed)
        .flat()
        .flatMap((u) => [u.call_count ?? 0, u.total_cputime ?? 0, u.total_time ?? 0]);
      this.usage = values.length ? Math.max(...values) : 0;
      if (this.usage > 75) this.logger.warn({ usage: this.usage }, 'Meta ads usage is high; syncs slow down');
    } catch {
      // A header we cannot read changes nothing.
    }
  }
}

/** Meta's review feedback (an object of reason → text, or a string) as one line. */
export function feedbackText(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === 'string') return raw.slice(0, 1000);
  if (typeof raw === 'object') {
    const values: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') values.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(raw);
    return values.length ? values.join(' ').slice(0, 1000) : null;
  }
  return null;
}

function toLead(r: Record<string, unknown>): MetaLead {
  const fields: Record<string, string> = {};
  for (const f of (Array.isArray(r.field_data) ? r.field_data : []) as Array<{ name?: string; values?: unknown[] }>) {
    if (f.name) fields[f.name] = String(f.values?.[0] ?? '');
  }
  const disclaimers: Record<string, boolean> = {};
  for (const d of (Array.isArray(r.custom_disclaimer_responses) ? r.custom_disclaimer_responses : []) as Array<{ checkbox_key?: string; is_checked?: unknown }>) {
    if (d.checkbox_key) disclaimers[d.checkbox_key] = d.is_checked === true || d.is_checked === '1' || d.is_checked === 1;
  }
  return {
    id: String(r.id ?? ''),
    createdTime: String(r.created_time ?? new Date().toISOString()),
    adId: typeof r.ad_id === 'string' ? r.ad_id : null,
    formId: typeof r.form_id === 'string' ? r.form_id : null,
    fields,
    disclaimers,
  };
}
