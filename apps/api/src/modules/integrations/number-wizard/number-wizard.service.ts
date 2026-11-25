import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { APP_CONFIG } from '../../../common/config/config.module.js';
import type { AppConfig } from '../../../common/config/config.js';
import { TokenCipher } from '../../../common/crypto/token-cipher.js';
import { AppError } from '../../../common/errors/app-error.js';
import { normalizePhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { MetaApiError, MetaGraphClient, type MetaTemplate, type TokenDebugInfo, type WizardPhoneNumber } from '../../meta/meta-graph.client.js';
import { NumbersService } from '../../numbers/numbers.service.js';
import { SettingsService } from '../../settings/settings.service.js';
import { appChecks, isReady, numberChecks, testMessageCheck, tokenChecks, wabaIdsFrom, worstOf, type WizardCheck } from './wizard-checks.js';

// The number connection wizard (feature 006 US8, FR-051 - FR-055, research R13,
// contracts/integrations-api.openapi.yaml tag number-wizard). The pasted token lives only in Redis,
// encrypted, for 30 minutes; check results are kept without it.

export const StartSchema = z.object({ accessToken: z.string().trim().min(20).max(1024) }).strict();
const NumberRef = { wabaId: z.string().trim().min(1).max(40), phoneNumberId: z.string().trim().min(1).max(40) };
export const ChecksSchema = z.object(NumberRef).strict();
export const FixSchema = z
  .object({ ...NumberRef, fix: z.enum(['REGISTER_NUMBER', 'SUBSCRIBE_APP']), pin: z.string().regex(/^[0-9]{6}$/, 'is 6 digits').optional() })
  .strict()
  .refine((v) => v.fix !== 'REGISTER_NUMBER' || v.pin !== undefined, { message: 'is required to register the number', path: ['pin'] });
export const TestMessageSchema = z.object({ ...NumberRef, to: z.string().trim().min(5).max(30) }).strict();
export const ConnectSchema = z.object({ ...NumberRef, label: z.string().trim().min(1).max(60), withoutTest: z.boolean().default(false) }).strict();
export type ChecksInput = z.infer<typeof ChecksSchema>;
export type FixInput = z.infer<typeof FixSchema>;
export type TestMessageInput = z.infer<typeof TestMessageSchema>;
export type ConnectInput = z.infer<typeof ConnectSchema>;

const SESSION_TTL_SECONDS = 30 * 60;
const key = (id: string) => `wbm:wizard:${id}`;

interface Session {
  userId: string;
  tokenEnc: string;
  wabaIds: string[];
  expiresAt: string;
  /** Numbers whose test message was sent in this session. */
  tested: string[];
}

export interface WizardResult {
  checks: WizardCheck[];
  ready: boolean;
}

@Injectable()
export class NumberWizardService {
  private readonly logger = new Logger(NumberWizardService.name);
  /** How long the test message waits for its delivered status (FR-054). */
  static deliveryWaitMs = 60_000;

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaGraphClient,
    private readonly cipher: TokenCipher,
    private readonly numbers: NumbersService,
    private readonly settings: SettingsService,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /** Checks the token and lists the accounts and numbers it reaches (FR-051). */
  async start(accessToken: string, actor: AuditActor & { userId: string }) {
    const debug = await this.debug(accessToken);
    if (!debug.isValid) {
      throw AppError.validation('Meta does not accept this token', [{ field: 'accessToken', issue: debug.error ?? 'is not a valid token' }], 'TOKEN_INVALID');
    }
    const wabaIds = wabaIdsFrom(debug);
    const known = new Set((await this.prisma.whatsAppNumber.findMany({ select: { phoneNumberId: true } })).map((n) => n.phoneNumberId));
    const accounts = [];
    for (const waba of await this.graph.listWabas(accessToken, wabaIds).catch(() => wabaIds.map((id) => ({ id, name: id, currency: null, timezoneId: null })))) {
      const phones = await this.graph.listPhoneNumbers(accessToken, waba.id).catch(() => [] as WizardPhoneNumber[]);
      accounts.push({
        wabaId: waba.id,
        name: waba.name,
        businessName: null,
        numbers: phones.map((p) => ({ phoneNumberId: p.id, displayPhoneNumber: p.displayPhoneNumber, verifiedName: p.verifiedName, alreadyConnected: known.has(p.id) })),
      });
    }
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + SESSION_TTL_SECONDS * 1000).toISOString();
    const session: Session = { userId: actor.userId, tokenEnc: this.cipher.encrypt(accessToken), wabaIds, expiresAt, tested: [] };
    await this.redis.set(key(id), JSON.stringify(session), 'EX', SESSION_TTL_SECONDS);
    return { id, expiresAt, token: worstOf(tokenChecks(debug, new Date())), accounts };
  }

  /** Every check on the chosen number (FR-052); results are saved without the token. */
  async checks(sessionId: string, input: ChecksInput, actor: AuditActor & { userId: string }): Promise<WizardResult> {
    const { token } = await this.open(sessionId, actor.userId, input.wabaId);
    return this.runAndSave(token, input, { runById: actor.userId });
  }

  /** One fix after the admin confirms (FR-053); then the checks again. */
  async fix(sessionId: string, input: FixInput, actor: AuditActor & { userId: string }): Promise<WizardResult> {
    const { token } = await this.open(sessionId, actor.userId, input.wabaId);
    try {
      if (input.fix === 'REGISTER_NUMBER') await this.graph.registerNumber(token, input.phoneNumberId, input.pin!);
      else await this.graph.subscribeApp(token, input.wabaId);
    } catch (error) {
      if (error instanceof MetaApiError) throw AppError.validation(`Meta refused the fix: ${error.message}`, [{ field: 'fix', issue: error.message }], 'FIX_FAILED');
      throw error;
    }
    // The PIN is never recorded.
    await this.audit.record(actor, 'number.fixed_with_wizard', { type: 'whatsapp_number', id: input.phoneNumberId }, { fix: input.fix, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId });
    return this.runAndSave(token, input, { runById: actor.userId });
  }

  /** An approved template to the admin's phone, waiting for its delivered status webhook (FR-054). */
  async testMessage(sessionId: string, input: TestMessageInput, actor: AuditActor & { userId: string }): Promise<{ sent: boolean; delivered: boolean; error: string | null }> {
    const { token, session } = await this.open(sessionId, actor.userId, input.wabaId);
    const { defaultCountryCode } = await this.settings.get();
    const phone = normalizePhone(input.to, defaultCountryCode);
    if (!phone) throw AppError.validation('Check the phone number', [{ field: 'to', issue: 'is not a valid phone number' }]);
    const template = await this.graph
      .listAllTemplates(token, input.wabaId)
      .then(pickTestTemplate)
      .catch(() => null);
    let result: { sent: boolean; delivered: boolean; error: string | null };
    if (!template) {
      result = { sent: false, delivered: false, error: 'the account has no approved template without variables; create one (for example hello_world) first' };
    } else {
      const since = new Date(Date.now() - 5_000);
      try {
        const { waMessageId } = await this.graph.sendTemplate(token, input.phoneNumberId, {
          to: phone.e164.slice(1),
          template: { name: template.name, language: { code: template.language }, components: [] },
        });
        session.tested = [...new Set([...session.tested, input.phoneNumberId])];
        await this.save(sessionId, session);
        const delivered = await this.waitForDelivered(waMessageId, since);
        result = { sent: true, delivered, error: delivered ? null : 'no delivered status arrived within 60 seconds' };
      } catch (error) {
        result = { sent: false, delivered: false, error: error instanceof Error ? error.message : 'the message could not be sent' };
      }
    }
    await this.recordTest(input, actor.userId, result);
    return result;
  }

  /** Saves the number through the 001 service, the token encrypted (FR-054). */
  async connect(sessionId: string, input: ConnectInput, actor: AuditActor & { userId: string }): Promise<{ id: string }> {
    const { token, session } = await this.open(sessionId, actor.userId, input.wabaId);
    if (!input.withoutTest && !session.tested.includes(input.phoneNumberId)) {
      throw AppError.validation('Send the test message first, or save without it', [{ field: 'withoutTest', issue: 'no test message was sent for this number' }], 'TEST_NOT_SENT');
    }
    if (await this.prisma.whatsAppNumber.findUnique({ where: { phoneNumberId: input.phoneNumberId }, select: { id: true } })) {
      throw AppError.conflict('This phone number is already connected', 'NUMBER_EXISTS');
    }
    const number = await this.numbers.connect({ label: input.label, wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, accessToken: token }, actor);
    await this.prisma.numberConnectionCheck.updateMany({ where: { phoneNumberId: input.phoneNumberId, numberId: null, runById: actor.userId }, data: { numberId: number.id } });
    await this.audit.record(actor, 'number.connected_with_wizard', { type: 'whatsapp_number', id: number.id }, { wabaId: input.wabaId, phoneNumberId: input.phoneNumberId, tested: !input.withoutTest });
    await this.redis.del(key(sessionId));
    return { id: number.id };
  }

  /** The checks on a connected number with its stored token; nothing is changed (FR-055). */
  async healthCheck(numberId: string, actor: AuditActor & { userId: string }): Promise<WizardResult> {
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { id: true, wabaId: true, phoneNumberId: true, accessTokenEnc: true } });
    if (!number) throw AppError.notFound('Number not found');
    return this.runAndSave(this.cipher.decrypt(number.accessTokenEnc), number, { runById: actor.userId, numberId: number.id });
  }

  private async runAndSave(token: string, ref: { wabaId: string; phoneNumberId: string }, row: { runById: string; numberId?: string }): Promise<WizardResult> {
    const checks = await this.run(token, ref.wabaId, ref.phoneNumberId);
    await this.prisma.numberConnectionCheck.create({
      data: { wabaId: ref.wabaId, phoneNumberId: ref.phoneNumberId, results: checks as unknown as Prisma.InputJsonValue, runById: row.runById, numberId: row.numberId ?? null },
    });
    return { checks, ready: isReady(checks) };
  }

  private async run(token: string, wabaId: string, phoneNumberId: string): Promise<WizardCheck[]> {
    const debug = await this.debug(token);
    const checks = tokenChecks(debug, new Date());
    if (!debug.isValid) return checks;
    const phone = await this.graph.phoneNumberDetails(token, phoneNumberId).catch((error: unknown) => error as Error);
    if (phone instanceof Error) {
      checks.push({ check: 'NUMBER_REGISTERED', result: 'FAILED', detail: `Meta could not find the number: ${phone.message}`, fix: 'Pick a number of this account, or check its id in WhatsApp Manager.', fixAction: null });
    } else {
      checks.push(...numberChecks(phone));
    }
    const appId = this.config.META_APP_ID ?? null;
    const [subscribedApps, subscriptions] = await Promise.all([
      this.graph.getSubscribedApps(token, wabaId).catch(() => null),
      appId ? this.graph.getAppSubscriptions(this.appToken()!, appId).catch(() => null) : Promise.resolve(null),
    ]);
    checks.push(...appChecks({ appId, subscribedApps, subscriptions, expectedCallback: `${this.config.APP_URL.replace(/\/+$/, '')}/api/webhooks/meta` }));
    return checks;
  }

  /** debug_token is read with the app token when the app id is set, otherwise with the token itself (R13). */
  private async debug(token: string): Promise<TokenDebugInfo> {
    try {
      return await this.graph.debugToken(token, this.appToken() ?? token);
    } catch (error) {
      if (error instanceof MetaApiError) return { isValid: false, appId: null, type: null, expiresAt: null, scopes: [], granularScopes: [], error: error.message };
      throw error;
    }
  }

  private appToken(): string | null {
    return this.config.META_APP_ID ? `${this.config.META_APP_ID}|${this.config.META_APP_SECRET}` : null;
  }

  /** The admin's own, unexpired session; its token decrypted. */
  private async open(sessionId: string, userId: string, wabaId: string): Promise<{ session: Session; token: string }> {
    const raw = await this.redis.get(key(sessionId));
    const session = raw ? (JSON.parse(raw) as Session) : null;
    if (!session || session.userId !== userId) throw AppError.notFound('The wizard session has expired; paste the token again');
    if (!session.wabaIds.includes(wabaId)) throw AppError.validation('Check the account', [{ field: 'wabaId', issue: 'is not an account this token can manage' }]);
    return { session, token: this.cipher.decrypt(session.tokenEnc) };
  }

  private async save(sessionId: string, session: Session): Promise<void> {
    const ttl = Math.max(1, Math.round((new Date(session.expiresAt).getTime() - Date.now()) / 1000));
    await this.redis.set(key(sessionId), JSON.stringify(session), 'EX', ttl);
  }

  /** The delivered (or read) status webhook for the message, as stored by the 001 receiver. */
  private async waitForDelivered(wamid: string, since: Date): Promise<boolean> {
    const deadline = Date.now() + NumberWizardService.deliveryWaitMs;
    const shape = (status: string) => JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: wamid, status }] } }] }] });
    for (;;) {
      const [row] = await this.prisma.$queryRaw<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM webhook_events
         WHERE received_at >= ${since} AND (payload @> ${shape('delivered')}::jsonb OR payload @> ${shape('read')}::jsonb)`;
      if ((row?.n ?? 0) > 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }

  private async recordTest(ref: { wabaId: string; phoneNumberId: string }, runById: string, result: { sent: boolean; delivered: boolean; error: string | null }): Promise<void> {
    const latest = await this.prisma.numberConnectionCheck.findFirst({ where: { phoneNumberId: ref.phoneNumberId, runById }, orderBy: { createdAt: 'desc' } });
    const check = testMessageCheck(result);
    if (!latest) {
      await this.prisma.numberConnectionCheck.create({ data: { wabaId: ref.wabaId, phoneNumberId: ref.phoneNumberId, results: [check] as unknown as Prisma.InputJsonValue, runById } });
      return;
    }
    const results = ((latest.results as unknown as WizardCheck[]) ?? []).filter((c) => c.check !== 'TEST_MESSAGE');
    await this.prisma.numberConnectionCheck.update({ where: { id: latest.id }, data: { results: [...results, check] as unknown as Prisma.InputJsonValue } });
  }
}

/** hello_world when the account has it, otherwise an approved template without variables or media. */
export function pickTestTemplate(templates: MetaTemplate[]): { name: string; language: string } | null {
  const approved = templates.filter((t) => t.status === 'APPROVED');
  const plain = (t: MetaTemplate) =>
    (t.components ?? []).every((c) => !/\{\{/.test(String((c as { text?: unknown }).text ?? '')) && !['IMAGE', 'VIDEO', 'DOCUMENT', 'LOCATION'].includes(String((c as { format?: unknown }).format ?? '')));
  const pick = approved.find((t) => t.name === 'hello_world' && plain(t)) ?? approved.find(plain);
  return pick ? { name: pick.name, language: pick.language } : null;
}
