import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import type { Prisma, StoreConnection } from '../../../generated/prisma/client.js';
import { ShopifyClient } from '../../integrations/stores/shopify/shopify.client.js';
import { StoreHttp, type WooCredentials } from '../../integrations/stores/store-http.js';
import { WooClient } from '../../integrations/stores/woocommerce/woo.client.js';
import { MetaCommerceClient, type BatchRequest } from '../meta-commerce.client.js';
import { CATALOG_BATCH_STATUS_JOB, CatalogService } from './catalog.service.js';

// Filling the catalog from a 006 store (feature 008 US5, FR-022, research R9): one catalog item per
// variant (`shp-<variantId>`, `woo-<productId>-<variationId>`), price as "150.00 AED". Only changed
// items are sent (a content hash per item), with deletions for items the store no longer has, in
// chunks through items_batch; each handle's status is checked later and per-item errors are kept on
// the connection. Graph error 80009 throws, so the job backs off and tries again.

const CHUNK = 500;
const MAX_ERRORS = 100;

export interface FillItem {
  retailerId: string;
  storeRef: string;
  title: string;
  description: string;
  availability: 'in stock' | 'out of stock';
  price: string;
  link: string | null;
  imageLink: string | null;
}

type Json = Record<string, unknown>;
const obj = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {});
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null);
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const plain = (html: string | null) => (html ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 5000);
const lastId = (gid: string) => gid.split('/').pop() ?? gid;

/** "150.00 AED": the amount, a space and the ISO code (R9). */
export function priceText(amount: string | number | null, currency: string): string | null {
  if (amount === null || (typeof amount === 'string' && amount.trim() === '')) return null;
  const n = typeof amount === 'number' ? amount : Number(amount);
  return Number.isFinite(n) && n >= 0 ? `${n.toFixed(2)} ${currency.toUpperCase()}` : null;
}

/** The items_batch data of one item, and its hash. */
export function batchData(item: FillItem, brand: string): { data: Record<string, string>; hash: string } {
  const data: Record<string, string> = {
    id: item.retailerId,
    title: item.title.slice(0, 200),
    description: item.description || item.title,
    availability: item.availability,
    condition: 'new',
    price: item.price,
    brand: brand.slice(0, 100),
    ...(item.link ? { link: item.link } : {}),
    ...(item.imageLink ? { image_link: item.imageLink } : {}),
  };
  return { data, hash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

/** Shopify products (GraphQL, REST-like nodes) as items, one per variant. */
export function shopifyItems(products: Json[], currency: string): FillItem[] {
  return products.flatMap((p) => {
    const image = str(obj(obj(obj(p.featuredMedia).preview).image).url);
    const link = str(p.onlineStoreUrl);
    const status = (str(p.status) ?? 'ACTIVE').toUpperCase();
    return list(obj(p.variants).nodes).flatMap((raw) => {
      const v = obj(raw);
      const id = str(v.id);
      const price = priceText(str(v.price), currency);
      if (!id || !price) return [];
      const variantTitle = str(v.title);
      return [
        {
          retailerId: `shp-${lastId(id)}`,
          storeRef: `shopify:${lastId(id)}`,
          title: `${str(p.title) ?? 'Product'}${variantTitle && variantTitle !== 'Default Title' ? ` - ${variantTitle}` : ''}`,
          description: plain(str(p.description)),
          availability: status === 'ACTIVE' && v.availableForSale !== false ? 'in stock' : 'out of stock',
          price,
          link,
          imageLink: str(obj(obj(obj(list(obj(v.media).nodes)[0]).preview).image).url) ?? image,
        } satisfies FillItem,
      ];
    });
  });
}

/** WooCommerce products and their variations as items. */
export function wooItems(products: Array<{ product: Json; variations: Json[] }>, currency: string): FillItem[] {
  return products.flatMap(({ product, variations }) => {
    const productId = str(product.id) ?? '';
    const image = str(obj(list(product.images)[0]).src);
    const published = (str(product.status) ?? 'publish') === 'publish';
    const rows = variations.length ? variations : [{ ...product, id: '0' }];
    return rows.flatMap((v) => {
      const price = priceText(str(v.price) ?? str(v.regular_price), currency);
      if (!productId || !price) return [];
      const variationId = str(v.id) ?? '0';
      const attributes = list(v.attributes).map((a) => str(obj(a).option)).filter(Boolean).join(', ');
      return [
        {
          retailerId: `woo-${productId}-${variationId}`,
          storeRef: `woo:${productId}:${variationId}`,
          title: `${str(product.name) ?? 'Product'}${variations.length && attributes ? ` - ${attributes}` : ''}`,
          description: plain(str(product.short_description) ?? str(product.description)),
          availability: published && (str(v.stock_status) ?? 'instock') === 'instock' ? 'in stock' : 'out of stock',
          price,
          link: str(product.permalink),
          imageLink: str(obj(v.image).src) ?? image,
        } satisfies FillItem,
      ];
    });
  });
}

@Injectable()
export class CatalogFill {
  private readonly logger = new Logger(CatalogFill.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly graph: MetaCommerceClient,
    private readonly shopify: ShopifyClient,
    private readonly woo: WooClient,
    private readonly http: StoreHttp,
    private readonly queues: QueueRegistry,
  ) {}

  /** Reads the store, sends what changed, and queues the status checks. */
  async run(now: Date = new Date()): Promise<{ sent: number; deleted: number }> {
    const connection = await this.catalog.connection();
    if (!connection?.fillEnabled || !connection.fillStoreId) return { sent: 0, deleted: 0 };
    const store = await this.prisma.storeConnection.findUnique({ where: { id: connection.fillStoreId } });
    if (!store || store.status === 'DISCONNECTED') return { sent: 0, deleted: 0 };
    const items = await this.read(store);
    const known = await this.prisma.catalogProduct.findMany({ where: { storeRef: { not: null } }, select: { retailerId: true, fillHash: true } });
    const hashes = new Map(known.map((k) => [k.retailerId, k.fillHash]));
    const requests: BatchRequest[] = [];
    const changed: Array<{ item: FillItem; hash: string }> = [];
    for (const item of items) {
      const { data, hash } = batchData(item, store.name);
      if (hashes.get(item.retailerId) === hash) continue;
      requests.push({ method: hashes.has(item.retailerId) ? 'UPDATE' : 'CREATE', data });
      changed.push({ item, hash });
    }
    const current = new Set(items.map((i) => i.retailerId));
    const gone = known.filter((k) => !current.has(k.retailerId)).map((k) => k.retailerId);
    for (const retailerId of gone) requests.push({ method: 'DELETE', data: { id: retailerId } });
    if (requests.length) {
      const token = await this.catalog.tokenFor(connection);
      for (let i = 0; i < requests.length; i += CHUNK) {
        // 80009 (too many calls to this catalog) throws: the job is retried with a back-off.
        const handle = await this.graph.itemsBatch(token, connection.catalogId, requests.slice(i, i + CHUNK));
        if (handle) await this.queues.get(QUEUES.CATALOG).add(CATALOG_BATCH_STATUS_JOB, { handle }, { delay: 30_000, attempts: 10, backoff: { type: 'fixed', delay: 30_000 }, removeOnComplete: true, removeOnFail: 50 });
      }
    }
    for (const { item, hash } of changed) {
      const row = { name: item.title.slice(0, 200), description: item.description || null, availability: item.availability, imageUrl: item.imageLink, url: item.link, storeRef: item.storeRef, fillHash: hash };
      await this.prisma.catalogProduct.upsert({ where: { retailerId: item.retailerId }, create: { retailerId: item.retailerId, ...row }, update: row });
    }
    if (gone.length) await this.prisma.catalogProduct.updateMany({ where: { retailerId: { in: gone } }, data: { removedAt: now, fillHash: null } });
    await this.prisma.catalogConnection.update({ where: { id: connection.id }, data: { lastFilledAt: now, ...(requests.length ? {} : { fillErrors: [] }) } });
    return { sent: changed.length, deleted: gone.length };
  }

  /** One batch handle: not finished yet throws (the job tries again); finished keeps its item errors. */
  async checkBatch(handle: string): Promise<void> {
    const connection = await this.catalog.connection();
    if (!connection) return;
    const token = await this.catalog.tokenFor(connection);
    const status = await this.graph.batchStatus(token, connection.catalogId, handle);
    if (status.status !== 'finished' && status.status !== 'error') throw new Error(`The catalog batch ${handle} is ${status.status}`);
    const errors = [...status.errors.map((e) => ({ retailerId: e.id ?? '', message: e.message.slice(0, 300) })), ...status.invalidIds.map((id) => ({ retailerId: id, message: 'Meta refused this item' }))].slice(0, MAX_ERRORS);
    if (errors.length) {
      // Failed items are sent again on the next fill.
      await this.prisma.catalogProduct.updateMany({ where: { retailerId: { in: errors.map((e) => e.retailerId).filter(Boolean) } }, data: { fillHash: null } });
    }
    await this.prisma.catalogConnection.update({ where: { id: connection.id }, data: { fillErrors: errors as unknown as Prisma.InputJsonValue } });
    this.logger.log({ handle, errors: errors.length }, 'Catalog batch checked');
  }

  private async read(store: StoreConnection): Promise<FillItem[]> {
    if (store.platform === 'SHOPIFY') {
      const token = await this.shopify.tokenFor(store);
      return shopifyItems(await this.shopify.products(store, token), await this.shopify.shopCurrency(store, token));
    }
    const credentials = this.http.open<WooCredentials>(store.credentialsEncrypted);
    const currency = (await this.woo.currency(store, credentials)) ?? 'aed';
    const products = await this.woo.products(store, credentials);
    const withVariations = [];
    for (const product of products) {
      const variations = str(product.type) === 'variable' ? await this.woo.variations(store, credentials, String(product.id)) : [];
      withVariations.push({ product, variations });
    }
    return wooItems(withVariations, currency);
  }
}
