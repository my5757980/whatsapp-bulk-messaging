import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { notSendableReason, parseCatalogPrice } from '@wbm/shared';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { Prisma, type CatalogConnection, type CatalogProduct, type WhatsAppNumber } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { MetaApiError } from '../../meta/meta-graph.client.js';
import { NotificationsService } from '../../notifications/notifications.service.js';
import { NumbersService } from '../../numbers/numbers.service.js';
import { MetaCommerceClient, type CatalogItem } from '../meta-commerce.client.js';

// The Meta catalog (feature 008 US5, FR-021 – FR-025, research R8, contracts/commerce-api.openapi.yaml
// tag catalog): which catalog each WhatsApp account has, connecting one (the first copy starts at
// once), the product copy refreshed hourly on the `catalog` queue, per-number commerce settings, and
// the product search agents use. Disconnecting stops product sending; the copy is kept 90 days.

export const CATALOG_SYNC_JOB = 'catalog-sync';
export const CATALOG_FILL_JOB = 'catalog-fill';
export const CATALOG_BATCH_STATUS_JOB = 'catalog-batch-status';
export const CATALOG_EVERY_MS = 60 * 60_000;

export const ConnectSchema = z.object({ catalogId: z.string().regex(/^[0-9]{5,30}$/) }).strict();
export const CommerceSettingsSchema = z.object({ cartEnabled: z.boolean(), catalogVisible: z.boolean() }).strict();
export const FillSchema = z.object({ enabled: z.boolean(), storeId: z.uuid().nullable().optional() }).strict();
export const ProductSearchSchema = z
  .object({
    search: z.string().trim().max(100).optional(),
    sendable: z.stringbool().optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
export type ProductSearch = z.infer<typeof ProductSearchSchema>;

type LiveNumber = Pick<WhatsAppNumber, 'id' | 'wabaId' | 'phoneNumberId' | 'displayPhoneNumber' | 'accessTokenEnc' | 'connectionStatus'>;

export function connectionDto(row: CatalogConnection) {
  return {
    catalogId: row.catalogId,
    name: row.name,
    syncStatus: row.syncStatus as 'IDLE' | 'RUNNING' | 'FAILED',
    lastSyncedAt: row.lastSyncedAt?.toISOString() ?? null,
    lastSyncError: row.lastSyncError,
    productCount: row.productCount,
    fillEnabled: row.fillEnabled,
    fillStoreId: row.fillStoreId,
    lastFilledAt: row.lastFilledAt?.toISOString() ?? null,
    fillErrors: (Array.isArray(row.fillErrors) ? row.fillErrors : []) as Array<{ retailerId: string; message: string }>,
  };
}

export function productDto(p: CatalogProduct) {
  const reason = notSendableReason(p);
  return {
    retailerId: p.retailerId,
    name: p.name,
    description: p.description,
    priceMinor: p.priceMinor === null ? null : Number(p.priceMinor),
    salePriceMinor: p.salePriceMinor === null ? null : Number(p.salePriceMinor),
    currency: p.currency,
    imageUrl: p.imageUrl,
    availability: p.availability,
    sendable: reason === null,
    notSendableReason: reason,
  };
}

/** One product of the Graph copy as a row (prices in minor units of its currency). */
export function productRow(item: CatalogItem, now: Date) {
  const currency = item.currency?.toLowerCase() ?? null;
  return {
    retailerId: item.retailerId.slice(0, 100),
    metaProductId: item.metaId.slice(0, 40) || null,
    name: item.name.slice(0, 200),
    description: item.description,
    priceMinor: parseCatalogPrice(item.price, currency) === null ? null : BigInt(parseCatalogPrice(item.price, currency)!),
    salePriceMinor: parseCatalogPrice(item.salePrice, currency) === null ? null : BigInt(parseCatalogPrice(item.salePrice, currency)!),
    currency,
    imageUrl: item.imageUrl,
    url: item.url,
    availability: item.availability.slice(0, 30),
    visibility: item.visibility?.slice(0, 20) ?? null,
    reviewStatus: item.reviewStatus?.slice(0, 20) ?? null,
    removedAt: null,
    syncedAt: now,
  };
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly graph: MetaCommerceClient,
    private readonly numbers: NumbersService,
    private readonly queues: QueueRegistry,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly metrics: MetricsService,
  ) {}

  connection(): Promise<CatalogConnection | null> {
    return this.prisma.catalogConnection.findFirst();
  }

  async requireConnection(): Promise<CatalogConnection> {
    const row = await this.connection();
    if (!row) throw AppError.conflict('Connect the Meta catalog first (Catalog page)', 'CATALOG_NOT_CONNECTED');
    return row;
  }

  private async liveNumbers(): Promise<LiveNumber[]> {
    return this.prisma.whatsAppNumber.findMany({
      where: { connectionStatus: 'CONNECTED' },
      select: { id: true, wabaId: true, phoneNumberId: true, displayPhoneNumber: true, accessTokenEnc: true, connectionStatus: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  /** The catalogs Meta reports for each of our WhatsApp accounts (one per account). */
  private async found(numbers: LiveNumber[]): Promise<Array<{ wabaId: string; catalogs: Array<{ id: string; name: string }> }>> {
    const byWaba = new Map<string, LiveNumber>();
    for (const n of numbers) if (!byWaba.has(n.wabaId)) byWaba.set(n.wabaId, n);
    const result = [];
    for (const [wabaId, number] of byWaba) {
      try {
        result.push({ wabaId, catalogs: await this.graph.wabaCatalogs(this.numbers.token(number), wabaId) });
      } catch (error) {
        this.logger.warn({ wabaId, err: error }, 'Could not read the catalogs of a WhatsApp account');
        result.push({ wabaId, catalogs: [] });
      }
    }
    return result;
  }

  /** A token of a number whose WhatsApp account has the connected catalog. */
  async tokenFor(connection: Pick<CatalogConnection, 'wabaChecks'>): Promise<string> {
    const wabas = ((Array.isArray(connection.wabaChecks) ? connection.wabaChecks : []) as Array<{ wabaId: string; connected: boolean }>).filter((c) => c.connected).map((c) => c.wabaId);
    const number = await this.prisma.whatsAppNumber.findFirst({ where: { connectionStatus: 'CONNECTED', ...(wabas.length ? { wabaId: { in: wabas } } : {}) }, orderBy: { createdAt: 'asc' } });
    if (!number) throw AppError.conflict('No connected WhatsApp number can reach the catalog', 'NUMBER_NO_CATALOG');
    return this.numbers.token(number);
  }

  /** True when the number's WhatsApp account has the connected catalog. */
  numberHasCatalog(connection: Pick<CatalogConnection, 'wabaChecks'>, wabaId: string): boolean {
    return ((Array.isArray(connection.wabaChecks) ? connection.wabaChecks : []) as Array<{ wabaId: string; connected: boolean }>).some((c) => c.wabaId === wabaId && c.connected);
  }

  /**
   * True when the number's account has the connected catalog; an account added since the last check
   * (a new number) is asked once and remembered.
   */
  async ensureNumberHasCatalog(connection: CatalogConnection, wabaId: string): Promise<boolean> {
    const checks = (Array.isArray(connection.wabaChecks) ? connection.wabaChecks : []) as Array<{ wabaId: string; connected: boolean }>;
    if (checks.some((c) => c.wabaId === wabaId)) return this.numberHasCatalog(connection, wabaId);
    const refreshed = await this.refreshWabaChecks(connection);
    return refreshed.some((c) => c.wabaId === wabaId && c.connected);
  }

  /** Which of our accounts have the connected catalog, saved on the connection. */
  async refreshWabaChecks(connection: Pick<CatalogConnection, 'id' | 'catalogId'>): Promise<Array<{ wabaId: string; connected: boolean }>> {
    const found = await this.found(await this.liveNumbers());
    const checks = found.map((f) => ({ wabaId: f.wabaId, connected: f.catalogs.some((c) => c.id === connection.catalogId) }));
    await this.prisma.catalogConnection.update({ where: { id: connection.id }, data: { wabaChecks: checks as Prisma.InputJsonValue } });
    return checks;
  }

  /** GET /catalog/connection. */
  async state() {
    const connection = await this.connection();
    const numbers = await this.liveNumbers();
    const found = await this.found(numbers);
    const rows = [];
    for (const n of numbers) {
      const catalogConnected = connection ? found.some((f) => f.wabaId === n.wabaId && f.catalogs.some((c) => c.id === connection.catalogId)) : false;
      let settings: { cartEnabled: boolean; catalogVisible: boolean } | null = null;
      if (catalogConnected) settings = await this.graph.commerceSettings(this.numbers.token(n), n.phoneNumberId).catch(() => null);
      rows.push({ numberId: n.id, phone: n.displayPhoneNumber, wabaId: n.wabaId, catalogConnected, cartEnabled: settings?.cartEnabled ?? null, catalogVisible: settings?.catalogVisible ?? null });
    }
    return { connection: connection ? connectionDto(connection) : null, found, numbers: rows };
  }

  /** POST /catalog/connection: the catalog must belong to one of our WhatsApp accounts. */
  async connect(catalogId: string, actor: AuditActor) {
    if (await this.connection()) throw AppError.conflict('A catalog is already connected; disconnect it first', 'ALREADY_CONNECTED');
    const numbers = await this.liveNumbers();
    const found = await this.found(numbers);
    const match = found.flatMap((f) => f.catalogs).find((c) => c.id === catalogId);
    if (!match) {
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'CATALOG_NOT_FOUND', 'This catalog is not connected to any of your WhatsApp Business Accounts in Meta Commerce Manager', [{ field: 'catalogId', issue: 'not found' }]);
    }
    const wabaChecks = found.map((f) => ({ wabaId: f.wabaId, connected: f.catalogs.some((c) => c.id === catalogId) }));
    const row = await this.prisma.catalogConnection.create({
      data: { catalogId, name: match.name.slice(0, 200) || catalogId, wabaChecks: wabaChecks as Prisma.InputJsonValue, syncStatus: 'RUNNING', connectedById: actor.userId ?? null },
    });
    await this.audit.record(actor, 'catalog.connected', { type: 'catalog_connection', id: row.id }, { catalogId, name: row.name });
    await this.enqueueSync('connect');
    return connectionDto(row);
  }

  /** DELETE /catalog/connection: product sending stops; the copy is kept (removed after 90 days). */
  async disconnect(actor: AuditActor): Promise<void> {
    const row = await this.connection();
    if (!row) throw AppError.notFound('No catalog is connected');
    await this.prisma.catalogConnection.delete({ where: { id: row.id } });
    await this.audit.record(actor, 'catalog.disconnected', { type: 'catalog_connection', id: row.id }, { catalogId: row.catalogId });
  }

  /** POST /catalog/sync. */
  async syncNow(): Promise<void> {
    const row = await this.requireConnection();
    if (row.syncStatus === 'RUNNING') throw AppError.conflict('The products are being copied already', 'SYNC_RUNNING');
    await this.prisma.catalogConnection.update({ where: { id: row.id }, data: { syncStatus: 'RUNNING' } });
    await this.enqueueSync('manual');
  }

  async enqueueSync(reason: string): Promise<void> {
    await this.queues.get(QUEUES.CATALOG).add(CATALOG_SYNC_JOB, { reason }, { jobId: `catalog-sync-${Date.now()}`, attempts: 3, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: true, removeOnFail: 50 });
  }

  /**
   * The product copy: every page of the catalog upserted by retailer id; products Meta no longer has
   * are marked removed. A failure marks the connection FAILED and tells the admins once.
   */
  async copy(now: Date = new Date()): Promise<{ products: number }> {
    const connection = await this.connection();
    if (!connection) return { products: 0 };
    try {
      await this.refreshWabaChecks(connection);
      const token = await this.tokenFor(await this.requireConnection());
      const seen = new Set<string>();
      let after: string | null = null;
      for (let page = 0; page < 1000; page += 1) {
        const result: { items: CatalogItem[]; next: string | null } = await this.graph.products(token, connection.catalogId, after);
        for (const item of result.items) {
          const row = productRow(item, now);
          seen.add(row.retailerId);
          await this.prisma.catalogProduct.upsert({ where: { retailerId: row.retailerId }, create: row, update: row });
        }
        if (!result.next) break;
        after = result.next;
      }
      await this.prisma.catalogProduct.updateMany({ where: { removedAt: null, retailerId: { notIn: [...seen] } }, data: { removedAt: now } });
      const count = await this.prisma.catalogProduct.count({ where: { removedAt: null } });
      await this.prisma.catalogConnection.update({ where: { id: connection.id }, data: { syncStatus: 'IDLE', lastSyncedAt: now, lastSyncError: null, productCount: count } });
      this.metrics.catalogSyncTotal.inc({ job: 'copy', result: 'ok' });
      return { products: count };
    } catch (error) {
      const reason = (error instanceof MetaApiError || error instanceof AppError ? error.message : 'Meta could not be reached').slice(0, 500);
      this.metrics.catalogSyncTotal.inc({ job: 'copy', result: 'failed' });
      const wasFailing = connection.syncStatus === 'FAILED';
      await this.prisma.catalogConnection.update({ where: { id: connection.id }, data: { syncStatus: 'FAILED', lastSyncError: reason } });
      if (!wasFailing) {
        await this.notifications.notifyAdmins({ type: 'CATALOG_SYNC_FAILED', title: 'The catalog could not be copied', body: `${connection.name}: ${reason}`, link: '/catalog' });
      }
      this.logger.warn({ err: error }, 'The catalog copy failed');
      return { products: connection.productCount };
    }
  }

  /** PUT /catalog/numbers/{id}/commerce-settings. */
  async setCommerceSettings(numberId: string, input: z.infer<typeof CommerceSettingsSchema>, actor: AuditActor) {
    const number = await this.prisma.whatsAppNumber.findUnique({ where: { id: numberId } });
    if (!number) throw AppError.notFound('WhatsApp number not found');
    const connection = await this.connection();
    try {
      await this.graph.setCommerceSettings(this.numbers.token(number), number.phoneNumberId, input);
    } catch (error) {
      if (error instanceof MetaApiError) throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'META_REFUSED', `Meta refused the change: ${error.message}`.slice(0, 300));
      throw error;
    }
    await this.audit.record(actor, 'catalog.commerce_settings_changed', { type: 'whatsapp_number', id: number.id }, input);
    return {
      numberId: number.id,
      phone: number.displayPhoneNumber,
      wabaId: number.wabaId,
      catalogConnected: connection ? this.numberHasCatalog(connection, number.wabaId) : false,
      cartEnabled: input.cartEnabled,
      catalogVisible: input.catalogVisible,
    };
  }

  /** PUT /catalog/fill (US5, R9): fill the catalog from a connected 006 store, hourly. */
  async setFill(input: z.infer<typeof FillSchema>, actor: AuditActor) {
    const row = await this.requireConnection();
    if (input.enabled) {
      const store = input.storeId ? await this.prisma.storeConnection.findUnique({ where: { id: input.storeId }, select: { status: true } }) : null;
      if (!store || store.status === 'DISCONNECTED') throw AppError.conflict('Choose a connected store to fill the catalog from', 'STORE_NOT_CONNECTED');
    }
    const updated = await this.prisma.catalogConnection.update({ where: { id: row.id }, data: { fillEnabled: input.enabled, fillStoreId: input.storeId ?? (input.enabled ? row.fillStoreId : row.fillStoreId) } });
    await this.audit.record(actor, 'catalog.fill_changed', { type: 'catalog_connection', id: row.id }, { enabled: input.enabled, storeId: updated.fillStoreId });
    if (input.enabled) await this.enqueueFill('enabled');
    return connectionDto(updated);
  }

  /** POST /catalog/fill/run. */
  async runFill(): Promise<void> {
    const row = await this.requireConnection();
    if (!row.fillEnabled || !row.fillStoreId) throw AppError.conflict('Turn on filling from a store first', 'FILL_NOT_ENABLED');
    await this.enqueueFill('manual');
  }

  async enqueueFill(reason: string): Promise<void> {
    await this.queues.get(QUEUES.CATALOG).add(CATALOG_FILL_JOB, { reason }, { jobId: `catalog-fill-${Date.now()}`, attempts: 5, backoff: { type: 'exponential', delay: 60_000 }, removeOnComplete: true, removeOnFail: 50 });
  }

  /** GET /catalog/products (SC-006): by name or retailer id, optionally only sendable ones. */
  async search(query: ProductSearch) {
    await this.requireConnection();
    const term = query.search?.trim();
    const where: Prisma.CatalogProductWhereInput = {
      ...(term ? { OR: [{ name: { contains: term, mode: 'insensitive' } }, { retailerId: { contains: term, mode: 'insensitive' } }] } : {}),
      ...(query.sendable
        ? {
            removedAt: null,
            availability: { in: ['in stock', 'available for order', 'in_stock', 'available_for_order'], mode: 'insensitive' as const },
            AND: [
              { OR: [{ reviewStatus: null }, { reviewStatus: { not: 'rejected' } }] },
              { OR: [{ visibility: null }, { visibility: { notIn: ['staging', 'hidden'] } }] },
            ],
          }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.catalogProduct.findMany({ where, orderBy: [{ removedAt: { sort: 'asc', nulls: 'first' } }, { name: 'asc' }], skip: (query.page - 1) * query.pageSize, take: query.pageSize }),
      this.prisma.catalogProduct.count({ where }),
    ]);
    const shown = query.sendable ? items.filter((p) => notSendableReason(p) === null) : items;
    return { items: shown.map(productDto), total };
  }
}
