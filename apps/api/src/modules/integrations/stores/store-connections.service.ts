import { randomBytes } from 'node:crypto';
import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { MAX_STORES } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { Prisma, StoreConnection } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { normaliseTag } from '../../contacts/tags.controller.js';
import { ShopifyClient } from './shopify/shopify.client.js';
import { StoreEventsInbox } from './store-events-inbox.js';
import { StoreHttp, plainStoreError, type ShopifyCredentials, type WooCredentials } from './store-http.js';
import { WooClient } from './woocommerce/woo.client.js';

// Store connections (feature 006 US4, FR-023 - FR-027, contracts/integrations-api.openapi.yaml):
// connect with an access test and the store's webhooks, change, disconnect and sync. Credentials are
// sealed and never returned.

export const STORE_AUTOMATION_KINDS = ['ORDER_CONFIRMED', 'ORDER_SHIPPED', 'ORDER_DELIVERED', 'ORDER_CANCELLED', 'COD_CONFIRMATION', 'CART_REMINDER', 'PAY_LINK'] as const;
export type StoreAutomationKindName = (typeof STORE_AUTOMATION_KINDS)[number];

const CredentialsSchema = z
  .object({
    clientId: z.string().trim().min(1).max(200),
    clientSecret: z.string().trim().min(1).max(500),
    accessToken: z.string().trim().min(1).max(500),
    consumerKey: z.string().trim().regex(/^ck_/, 'starts with ck_').max(200),
    consumerSecret: z.string().trim().regex(/^cs_/, 'starts with cs_').max(200),
  })
  .partial()
  .strict();

const country = z.string().regex(/^[A-Z]{2}$/, 'use a two-letter country code such as AE');
const tag = z.string().trim().min(1).max(50);

export const StoreConnectSchema = z
  .object({
    platform: z.enum(['SHOPIFY', 'WOOCOMMERCE']),
    baseUrl: z.string().trim().min(1).max(255),
    numberId: z.uuid(),
    defaultCountry: country,
    customerTag: tag,
    credentials: CredentialsSchema,
  })
  .strict();
export type StoreConnectInput = z.infer<typeof StoreConnectSchema>;

export const StorePatchSchema = z
  .object({
    numberId: z.uuid(),
    defaultCountry: country,
    customerTag: tag,
    consentIsWhatsapp: z.boolean(),
    shippedStatus: z.string().trim().min(1).max(40).nullable(),
    deliveredStatus: z.string().trim().min(1).max(40).nullable(),
    credentials: CredentialsSchema,
  })
  .partial()
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Change at least one field' });
export type StorePatchInput = z.infer<typeof StorePatchSchema>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const accessFailed = (error: unknown) => new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'STORE_ACCESS_FAILED', plainStoreError(error));

@Injectable()
export class StoreConnectionsService {
  private readonly logger = new Logger(StoreConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: StoreHttp,
    private readonly shopify: ShopifyClient,
    private readonly woo: WooClient,
    private readonly inbox: StoreEventsInbox,
    private readonly audit: AuditService,
  ) {}

  async list() {
    const stores = await this.prisma.storeConnection.findMany({ orderBy: { createdAt: 'desc' } });
    const automations = await this.prisma.storeAutomation.findMany({ where: { storeId: { in: stores.map((s) => s.id) } }, select: { storeId: true, kind: true, enabled: true } });
    return stores.map((s) => this.toDto(s, automations.filter((a) => a.storeId === s.id)));
  }

  async get(id: string) {
    const store = await this.load(id);
    const automations = await this.prisma.storeAutomation.findMany({ where: { storeId: id }, select: { kind: true, enabled: true } });
    return this.toDto(store, automations);
  }

  async load(id: string): Promise<StoreConnection> {
    const store = await this.prisma.storeConnection.findUnique({ where: { id } });
    if (!store) throw AppError.notFound('Store not found');
    return store;
  }

  async connect(input: StoreConnectInput, actor: AuditActor & { userId: string }) {
    const baseUrl = this.normaliseUrl(input.platform, input.baseUrl);
    const credentials = this.checkCredentials(input.platform, input.credentials);
    await this.assertNumber(input.numberId);
    if ((await this.prisma.storeConnection.count({ where: { status: { not: 'DISCONNECTED' } } })) >= MAX_STORES) {
      throw AppError.conflict(`At most ${MAX_STORES} stores can be connected; disconnect one first`, 'TOO_MANY_STORES');
    }
    if (await this.prisma.storeConnection.findFirst({ where: { baseUrl, status: { not: 'DISCONNECTED' } }, select: { id: true } })) {
      throw AppError.conflict('This store is already connected', 'STORE_EXISTS');
    }

    // The access test: a token (Shopify) or the keys (WooCommerce), and the store's name.
    let name: string;
    let token: { token: string; expiresAt: Date } | null = null;
    try {
      if (input.platform === 'SHOPIFY') {
        const c = credentials as ShopifyCredentials;
        token = c.clientId ? await this.shopify.exchangeToken(baseUrl, c.clientId, c.clientSecret) : null;
        name = await this.shopify.shopName(baseUrl, token?.token ?? c.accessToken!);
      } else {
        name = await this.woo.siteName(baseUrl);
        await this.woo.testKeys(baseUrl, credentials as WooCredentials);
      }
    } catch (error) {
      throw accessFailed(error);
    }

    const webhookSecret = input.platform === 'WOOCOMMERCE' ? randomBytes(32).toString('base64url') : null;
    const store = await this.prisma.storeConnection.create({
      data: {
        platform: input.platform,
        name: name.slice(0, 120),
        baseUrl,
        credentialsEncrypted: this.http.seal(credentials),
        webhookSecretEncrypted: webhookSecret ? this.http.seal({ secret: webhookSecret }) : null,
        accessTokenEncrypted: token ? this.http.seal({ token: token.token }) : null,
        tokenExpiresAt: token?.expiresAt ?? null,
        numberId: input.numberId,
        defaultCountry: input.defaultCountry,
        customerTag: normaliseTag(input.customerTag),
        shippedStatus: input.platform === 'WOOCOMMERCE' ? 'completed' : null,
        createdById: actor.userId,
      },
    });
    try {
      if (input.platform === 'SHOPIFY') await this.shopify.ensureSubscriptions(store, await this.shopify.tokenFor(store));
      else await this.woo.ensureWebhooks(store, credentials as WooCredentials, webhookSecret!);
    } catch (error) {
      await this.prisma.storeConnection.delete({ where: { id: store.id } });
      throw accessFailed(error);
    }
    await this.audit.record(actor, 'store.connected', { type: 'store', id: store.id }, { platform: store.platform, name: store.name, baseUrl });
    return this.get(store.id);
  }

  async update(id: string, input: StorePatchInput, actor: AuditActor & { userId: string }) {
    const store = await this.load(id);
    if (input.numberId) await this.assertNumber(input.numberId);
    if (store.platform !== 'WOOCOMMERCE' && (input.shippedStatus !== undefined || input.deliveredStatus !== undefined)) {
      throw AppError.validation('Order status names are for WooCommerce stores', [{ field: input.shippedStatus !== undefined ? 'shippedStatus' : 'deliveredStatus', issue: 'is for WooCommerce only' }]);
    }
    const data: Prisma.StoreConnectionUncheckedUpdateInput = {
      ...(input.numberId ? { numberId: input.numberId } : {}),
      ...(input.defaultCountry ? { defaultCountry: input.defaultCountry } : {}),
      ...(input.customerTag ? { customerTag: normaliseTag(input.customerTag) } : {}),
      ...(input.shippedStatus !== undefined ? { shippedStatus: input.shippedStatus ?? 'completed' } : {}),
      ...(input.deliveredStatus !== undefined ? { deliveredStatus: input.deliveredStatus } : {}),
    };
    if (input.consentIsWhatsapp !== undefined && input.consentIsWhatsapp !== store.consentIsWhatsapp) {
      Object.assign(data, input.consentIsWhatsapp
        ? { consentIsWhatsapp: true, consentConfirmedById: actor.userId, consentConfirmedAt: new Date() }
        : { consentIsWhatsapp: false, consentConfirmedById: null, consentConfirmedAt: null });
    }
    if (input.credentials) {
      const credentials = this.checkCredentials(store.platform, { ...this.http.open<Record<string, string>>(store.credentialsEncrypted), ...input.credentials });
      try {
        if (store.platform === 'SHOPIFY') {
          const c = credentials as ShopifyCredentials;
          const token = c.clientId ? await this.shopify.exchangeToken(store.baseUrl, c.clientId, c.clientSecret) : null;
          await this.shopify.shopName(store.baseUrl, token?.token ?? c.accessToken!);
          Object.assign(data, { accessTokenEncrypted: token ? this.http.seal({ token: token.token }) : null, tokenExpiresAt: token?.expiresAt ?? null });
        } else {
          await this.woo.testKeys(store.baseUrl, credentials as WooCredentials);
        }
      } catch (error) {
        throw accessFailed(error);
      }
      Object.assign(data, { credentialsEncrypted: this.http.seal(credentials), status: store.status === 'ERROR' ? 'CONNECTED' : store.status, lastError: null });
    }
    await this.prisma.storeConnection.update({ where: { id }, data });
    const changed = Object.keys(input);
    if (input.consentIsWhatsapp === true && !store.consentIsWhatsapp) await this.audit.record(actor, 'store.consent_confirmed', { type: 'store', id }, { name: store.name });
    if (changed.some((k) => k !== 'consentIsWhatsapp')) await this.audit.record(actor, 'store.updated', { type: 'store', id }, { changed: changed.filter((k) => k !== 'credentials').concat(input.credentials ? ['credentials'] : []) });
    return this.get(id);
  }

  /** Automations stop and the store's webhooks are removed (best effort: the store may be gone). */
  async disconnect(id: string, actor: AuditActor) {
    const store = await this.load(id);
    if (store.status !== 'DISCONNECTED') {
      try {
        if (store.platform === 'SHOPIFY') await this.shopify.removeSubscriptions(store, await this.shopify.tokenFor(store));
        else await this.woo.removeWebhooks(store, this.http.open<WooCredentials>(store.credentialsEncrypted));
      } catch (error) {
        this.logger.warn({ storeId: id, reason: plainStoreError(error) }, 'Could not remove the store webhooks');
      }
      await this.prisma.$transaction([
        this.prisma.storeConnection.update({ where: { id }, data: { status: 'DISCONNECTED', accessTokenEncrypted: null, tokenExpiresAt: null } }),
        this.prisma.storeAutomation.updateMany({ where: { storeId: id }, data: { enabled: false } }),
      ]);
      await this.audit.record(actor, 'store.disconnected', { type: 'store', id }, { platform: store.platform, name: store.name });
    }
    return this.get(id);
  }

  async sync(id: string): Promise<void> {
    const store = await this.load(id);
    if (store.status === 'DISCONNECTED') throw AppError.conflict('The store is disconnected', 'STORE_DISCONNECTED');
    await this.inbox.requestSync(id);
  }

  private toDto(store: StoreConnection, automations: Array<{ kind: string; enabled: boolean }>) {
    return {
      id: store.id,
      platform: store.platform,
      name: store.name,
      baseUrl: store.baseUrl,
      numberId: store.numberId,
      defaultCountry: store.defaultCountry,
      customerTag: store.customerTag,
      consentIsWhatsapp: store.consentIsWhatsapp,
      consentConfirmedAt: store.consentConfirmedAt?.toISOString() ?? null,
      shippedStatus: store.shippedStatus,
      deliveredStatus: store.deliveredStatus,
      status: store.status,
      lastError: store.lastError,
      lastEventAt: store.lastEventAt?.toISOString() ?? null,
      lastSyncedAt: store.lastSyncedAt?.toISOString() ?? null,
      createdAt: store.createdAt.toISOString(),
      automations: STORE_AUTOMATION_KINDS.map((kind) => ({ kind, enabled: automations.find((a) => a.kind === kind)?.enabled ?? false })),
    };
  }

  private normaliseUrl(platform: 'SHOPIFY' | 'WOOCOMMERCE', raw: string): string {
    const fail = (issue: string) => AppError.validation('Check the store address', [{ field: 'baseUrl', issue }]);
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw fail('is not a web address');
    }
    const local = this.http.allowLocal && LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) throw fail('must start with https://');
    if (url.username || url.password || url.search || url.hash) throw fail('must be only the store address');
    if (platform === 'SHOPIFY' && !local && !url.hostname.endsWith('.myshopify.com')) throw fail('use the store’s myshopify.com address, for example https://your-shop.myshopify.com');
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
  }

  private checkCredentials(platform: 'SHOPIFY' | 'WOOCOMMERCE', c: Record<string, string | undefined>): ShopifyCredentials | WooCredentials {
    if (platform === 'SHOPIFY') {
      if (!c.clientSecret || (!c.clientId && !c.accessToken)) {
        throw AppError.validation('Add the app’s client ID and client secret (or a legacy access token and its client secret)', [{ field: 'credentials', issue: 'are incomplete' }]);
      }
      return { clientSecret: c.clientSecret, ...(c.clientId ? { clientId: c.clientId } : { accessToken: c.accessToken }) };
    }
    if (!c.consumerKey || !c.consumerSecret) throw AppError.validation('Add the REST API consumer key and secret', [{ field: 'credentials', issue: 'are incomplete' }]);
    return { consumerKey: c.consumerKey, consumerSecret: c.consumerSecret };
  }

  private async assertNumber(numberId: string): Promise<void> {
    if (!(await this.prisma.whatsAppNumber.findUnique({ where: { id: numberId }, select: { id: true } }))) {
      throw AppError.validation('Choose a WhatsApp number of the company', [{ field: 'numberId', issue: 'is not a WhatsApp number of the company' }]);
    }
  }
}
