import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  adAccountChecks,
  adsReady,
  adsTokenChecks,
  audienceTermsCheck,
  localParts,
  monthLeft,
  pageChecks,
  worstAdsCheck,
  type AdsCheck,
} from '@wbm/shared';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import type { AdsConnection, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { MetaApiError, MetaGraphClient, type TokenDebugInfo } from '../../meta/meta-graph.client.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { MetaAdsClient } from '../meta-ads.client.js';

// The ads connection (feature 007 US1, FR-001 – FR-004, research R1, R2, contracts/ads-api.openapi.yaml):
// a token session in Redis (encrypted, 30 minutes, as the 006 number wizard), the checks with a fix
// each, one saved connection row with the tokens encrypted, the spending cap, and the ERROR state.

export const TokenSchema = z.object({ accessToken: z.string().trim().min(20).max(1024) }).strict();
export const SaveSchema = z.object({ sessionId: z.uuid(), adAccountId: z.string().trim().min(1).max(40), pageId: z.string().trim().min(1).max(40) }).strict();
export const ChecksSchema = z
  .object({ sessionId: z.uuid().optional(), adAccountId: z.string().trim().min(1).max(40).optional(), pageId: z.string().trim().min(1).max(40).optional() })
  .strict()
  .refine((v) => !v.sessionId || (v.adAccountId && v.pageId), { message: 'choose the ad account and the page', path: ['adAccountId'] });
export const CapSchema = z.object({ monthlyCapMinor: z.number().int().min(1).nullable() }).strict();

const SESSION_TTL_SECONDS = 30 * 60;
const sessionKey = (id: string) => `wbm:ads-session:${id}`;

interface Session {
  userId: string;
  tokenEnc: string;
  expiresAt: string;
  pages: Array<{ id: string; name: string; tasks: string[]; tokenEnc: string | null }>;
}

export interface CheckResult {
  checks: AdsCheck[];
  ready: boolean;
  /** WhatsApp numbers linked to the page, as Meta writes them; null when Meta does not say. */
  linkedNumbers: string[] | null;
  account: { name: string; currency: string; timezone: string } | null;
  page: { name: string } | null;
}

/** What other ads services get: the row and its decrypted tokens. */
export interface AdsAccess {
  row: AdsConnection;
  token: string;
  pageToken: string | null;
}

@Injectable()
export class AdsConnectionService {
  private readonly logger = new Logger(AdsConnectionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ads: MetaAdsClient,
    private readonly graph: MetaGraphClient,
    private readonly cipher: TokenCipher,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Checks the pasted token and lists the ad accounts and pages it reaches. */
  async startSession(accessToken: string, actor: AuditActor & { userId: string }) {
    const debug = await this.debug(accessToken);
    if (!debug.isValid) throw AppError.validation('Meta does not accept this token', [{ field: 'accessToken', issue: debug.error ?? 'is not a valid token' }], 'TOKEN_INVALID');
    const [accounts, pages] = await Promise.all([this.ads.adAccounts(accessToken), this.ads.pages(accessToken)]);
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    const session: Session = {
      userId: actor.userId,
      tokenEnc: this.cipher.encrypt(accessToken),
      expiresAt,
      pages: pages.map((p) => ({ id: p.id, name: p.name, tasks: p.tasks, tokenEnc: p.accessToken ? this.cipher.encrypt(p.accessToken) : null })),
    };
    await this.redis.set(sessionKey(id), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
    return {
      id,
      expiresAt,
      token: worstAdsCheck(adsTokenChecks(debug, new Date())),
      adAccounts: accounts.map((a) => ({ id: a.id, name: a.name, currency: a.currency, timezone: a.timezone, active: a.accountStatus === 1 })),
      pages: pages.map((p) => ({ id: p.id, name: p.name })),
    };
  }

  /** The checks for an account and page chosen in a session. */
  async sessionChecks(sessionId: string, adAccountId: string, pageId: string, userId: string) {
    const { token } = await this.open(sessionId, userId);
    const result = await this.runChecks(token, adAccountId, pageId);
    return { checks: result.checks, ready: result.ready };
  }

  /** Saves the connection; the token and page token are stored encrypted and never returned. */
  async save(input: z.infer<typeof SaveSchema>, actor: AuditActor & { userId: string }) {
    const { session, token } = await this.open(input.sessionId, actor.userId);
    const result = await this.runChecks(token, input.adAccountId, input.pageId);
    if (!result.ready || !result.account || !result.page) {
      throw AppError.validation(
        'Fix the failed checks first',
        result.checks.filter((c) => c.result === 'FAILED').map((c) => ({ field: c.check, issue: c.detail })),
        'CHECKS_FAILED',
      );
    }
    const page = session.pages.find((p) => p.id === input.pageId);
    const data = {
      adAccountId: input.adAccountId,
      adAccountName: result.account.name,
      pageId: input.pageId,
      pageName: result.page.name,
      tokenEnc: session.tokenEnc,
      pageTokenEnc: page?.tokenEnc ?? null,
      currency: result.account.currency,
      timezone: result.account.timezone,
      status: 'CONNECTED' as const,
      checks: this.checksJson(result),
      checkedAt: new Date(),
      connectedById: actor.userId,
    };
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.adsConnection.findFirst({ select: { id: true, monthlyCapMinor: true } });
      if (existing) await tx.adsConnection.update({ where: { id: existing.id }, data });
      else await tx.adsConnection.create({ data });
    });
    await this.redis.del(sessionKey(input.sessionId));
    await this.audit.record(actor, 'ads.connected', { type: 'ads_connection', id: input.adAccountId }, { adAccountId: input.adAccountId, pageId: input.pageId });
    return (await this.get())!;
  }

  /** The current connection with its last checks; null when nothing is connected. */
  async get() {
    const row = await this.prisma.adsConnection.findFirst();
    if (!row) return null;
    const stored = (row.checks ?? {}) as { checks?: AdsCheck[]; ready?: boolean; linkedNumbers?: string[] | null };
    const numbers = await this.prisma.whatsAppNumber.findMany({ where: { connectionStatus: { not: 'DISCONNECTED' } }, select: { id: true, displayPhoneNumber: true } });
    const linked = stored.linkedNumbers;
    const digits = (s: string) => s.replace(/\D/g, '');
    const linkedNumberIds = linked ? numbers.filter((n) => linked.some((l) => digits(l) === digits(n.displayPhoneNumber))).map((n) => n.id) : numbers.map((n) => n.id);
    return {
      adAccountId: row.adAccountId,
      adAccountName: row.adAccountName,
      pageId: row.pageId,
      pageName: row.pageName,
      currency: row.currency,
      timezone: row.timezone,
      status: row.status,
      checks: { checks: stored.checks ?? [], ready: stored.ready ?? row.status === 'CONNECTED' },
      checkedAt: row.checkedAt?.toISOString() ?? null,
      monthlyCapMinor: row.monthlyCapMinor === null ? null : Number(row.monthlyCapMinor),
      monthSpendMinor: await this.monthSpendMinor(row),
      linkedNumberIds,
      linkedNumbersKnown: Boolean(linked),
    };
  }

  /** Runs the checks again with the stored token; a failure sets ERROR and alerts admins (FR-004). */
  async recheck(actor: AuditActor) {
    const row = await this.requireRow();
    const result = await this.runChecks(this.cipher.decrypt(row.tokenEnc), row.adAccountId, row.pageId);
    await this.applyResult(row, result);
    await this.audit.record(actor, 'ads.checks_run', { type: 'ads_connection', id: row.adAccountId }, { ready: result.ready });
    return { checks: result.checks, ready: result.ready };
  }

  async setCap(monthlyCapMinor: number | null, actor: AuditActor) {
    const row = await this.requireRow();
    await this.prisma.adsConnection.update({ where: { id: row.id }, data: { monthlyCapMinor: monthlyCapMinor === null ? null : BigInt(monthlyCapMinor), cappedMonth: null } });
    await this.audit.record(actor, 'ads.spend_cap_changed', { type: 'ads_connection', id: row.adAccountId }, { monthlyCapMinor, currency: row.currency });
    return (await this.get())!;
  }

  /** Ads keep running at Meta; platform campaigns become read-only. */
  async disconnect(actor: AuditActor): Promise<void> {
    const row = await this.requireRow();
    await this.prisma.adsConnection.delete({ where: { id: row.id } });
    await this.audit.record(actor, 'ads.disconnected', { type: 'ads_connection', id: row.adAccountId }, { adAccountId: row.adAccountId, pageId: row.pageId });
  }

  /** The connection with its tokens for changes at Meta; refused when missing or in error (FR-004). */
  async requireUsable(): Promise<AdsAccess> {
    const access = await this.access();
    if (!access) throw AppError.conflict('Connect the ad account first (Ads > Connect)', 'NOT_CONNECTED');
    if (access.row.status !== 'CONNECTED') throw AppError.conflict('The ads connection has a problem; run its checks and fix it first', 'CONNECTION_ERROR');
    return access;
  }

  /** The connection with its tokens, whatever its state (syncs read even in error). */
  async access(): Promise<AdsAccess | null> {
    const row = await this.prisma.adsConnection.findFirst();
    if (!row) return null;
    return { row, token: this.cipher.decrypt(row.tokenEnc), pageToken: row.pageTokenEnc ? this.cipher.decrypt(row.pageTokenEnc) : null };
  }

  /** Marks the connection in error after a Graph token or account failure seen elsewhere. */
  async markError(reason: string): Promise<void> {
    const row = await this.prisma.adsConnection.findFirst();
    if (!row || row.status === 'ERROR') return;
    await this.prisma.adsConnection.update({ where: { id: row.id }, data: { status: 'ERROR' } });
    await this.notifications.notifyAdmins({ type: 'ADS_CONNECTION_ERROR', title: 'The ads connection needs attention', body: reason, link: '/ads/connect' });
  }

  /** Spend this month (account time zone) from Meta's daily numbers. */
  async monthSpendMinor(row: Pick<AdsConnection, 'timezone'>, now = new Date()): Promise<number> {
    const { firstDay } = monthLeft(now, row.timezone);
    const { year, month, day } = localParts(now, row.timezone);
    const today = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const [sum] = await this.prisma.$queryRaw<Array<{ spend: bigint | null }>>`
      SELECT sum(spend_minor) AS spend FROM ad_result_days
       WHERE ad_version_id IS NULL AND day >= ${firstDay}::date AND day <= ${today}::date`;
    return Number(sum?.spend ?? 0);
  }

  private async runChecks(token: string, adAccountId: string, pageId: string): Promise<CheckResult> {
    const debug = await this.debug(token);
    const checks: AdsCheck[] = adsTokenChecks(debug, new Date());
    if (!debug.isValid) return { checks, ready: false, linkedNumbers: null, account: null, page: null };
    let account: CheckResult['account'] = null;
    try {
      const a = await this.ads.adAccount(token, adAccountId);
      account = { name: a.name, currency: a.currency, timezone: a.timezone };
      checks.push(...adAccountChecks({ accountStatus: a.accountStatus, disableReason: a.disableReason, hasPaymentMethod: a.hasPaymentMethod, currency: a.currency, timezone: a.timezone }));
      checks.push(audienceTermsCheck(a.audienceTermsAccepted));
    } catch (error) {
      checks.push({ check: 'AD_ACCOUNT_ACTIVE', result: 'FAILED', detail: `Meta could not read the ad account: ${message(error)}`, fix: 'Give the system user access to the ad account in Business Settings.' });
    }
    let page: CheckResult['page'] = null;
    let linkedNumbers: string[] | null = null;
    try {
      const pages = await this.ads.pages(token);
      const found = pages.find((p) => p.id === pageId);
      if (!found) {
        checks.push({ check: 'PAGE_ADS', result: 'FAILED', detail: 'The token cannot see this page.', fix: 'Give the system user access to the page in Business Settings.' });
      } else {
        page = { name: found.name };
        const facts = await this.ads.pageAdsFacts(token, pageId).catch(() => ({ leadTermsAccepted: null, whatsappNumbers: null }));
        linkedNumbers = facts.whatsappNumbers;
        checks.push(...pageChecks({ name: found.name, tasks: found.tasks, whatsappNumbers: facts.whatsappNumbers, leadTermsAccepted: facts.leadTermsAccepted }));
      }
    } catch (error) {
      checks.push({ check: 'PAGE_ADS', result: 'FAILED', detail: `Meta could not read the pages: ${message(error)}`, fix: 'Give the system user access to the page in Business Settings.' });
    }
    return { checks, ready: adsReady(checks), linkedNumbers, account, page };
  }

  private async applyResult(row: AdsConnection, result: CheckResult): Promise<void> {
    const status = result.ready ? 'CONNECTED' : 'ERROR';
    await this.prisma.adsConnection.update({
      where: { id: row.id },
      data: {
        status,
        checks: this.checksJson(result),
        checkedAt: new Date(),
        ...(result.account ? { currency: result.account.currency, timezone: result.account.timezone, adAccountName: result.account.name } : {}),
        ...(result.page ? { pageName: result.page.name } : {}),
      },
    });
    if (status === 'ERROR' && row.status !== 'ERROR') {
      const failed = result.checks.filter((c) => c.result === 'FAILED').map((c) => c.detail);
      await this.notifications.notifyAdmins({ type: 'ADS_CONNECTION_ERROR', title: 'The ads connection needs attention', body: failed.join(' ') || 'A check failed.', link: '/ads/connect' });
    }
  }

  private checksJson(result: CheckResult): Prisma.InputJsonValue {
    return { checks: result.checks, ready: result.ready, linkedNumbers: result.linkedNumbers } as unknown as Prisma.InputJsonValue;
  }

  private async requireRow(): Promise<AdsConnection> {
    const row = await this.prisma.adsConnection.findFirst();
    if (!row) throw AppError.notFound('Nothing is connected');
    return row;
  }

  private async open(sessionId: string, userId: string): Promise<{ session: Session; token: string }> {
    const raw = await this.redis.get(sessionKey(sessionId));
    const session = raw ? (JSON.parse(raw) as Session) : null;
    if (!session || session.userId !== userId) throw AppError.notFound('The session has expired; paste the token again');
    return { session, token: this.cipher.decrypt(session.tokenEnc) };
  }

  /** debug_token with the app token when the app id is set, otherwise with the token itself (as 006). */
  private async debug(token: string): Promise<TokenDebugInfo> {
    const appToken = this.config.META_APP_ID ? `${this.config.META_APP_ID}|${this.config.META_APP_SECRET}` : token;
    try {
      return await this.graph.debugToken(token, appToken);
    } catch (error) {
      if (error instanceof MetaApiError) return { isValid: false, appId: null, type: null, expiresAt: null, scopes: [], granularScopes: [], error: error.message };
      throw error;
    }
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown error';
}
