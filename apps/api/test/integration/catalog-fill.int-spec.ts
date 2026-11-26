import { createHash, randomUUID } from 'node:crypto';
import nock from 'nock';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { QUEUES } from '../../src/common/queue/queue.constants.js';
import { QueueRegistry } from '../../src/common/queue/queue.module.js';
import { CatalogFill } from '../../src/modules/commerce/catalog/catalog-fill.js';
import { CatalogService } from '../../src/modules/commerce/catalog/catalog.service.js';
import { clearCommerce } from '../support/commerce.js';
import { FAKE_CATALOG_ID, FakeCommerceGraph } from '../support/fake-commerce-graph.js';
import { restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, uniq, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T063 (feature 008 US5, FR-022, research R9): filling the catalog from a Shopify and a WooCommerce
// store, one item per variant with the retailer id rules, prices as "150.00 AED", only changed items
// sent, deletions, batch status checks with per-item errors, the 80009 back-off, and the audit entry.

const VERSION = process.env.SHOPIFY_API_VERSION ?? '2026-10';
type Json = Record<string, unknown>;

describe('Catalog fill from a store (008 US5)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let graph: FakeCommerceGraph;
  let numberId: string;

  const api = (method: 'get' | 'post' | 'put', url: string, body?: object) => {
    const req = admin.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', admin.csrf).send(body ?? {});
  };
  const fill = () => ctx.app.get(CatalogFill).run();
  const batchJobs = async () => {
    const jobs = await ctx.app.get(QueueRegistry).get(QUEUES.CATALOG).getJobs(['waiting', 'delayed', 'prioritized']);
    return jobs.filter((j) => j.name === 'catalog-batch-status');
  };
  const runBatchChecks = async () => {
    for (const job of await batchJobs()) {
      await ctx.app.get(CatalogFill).checkBatch((job.data as { handle: string }).handle).catch(() => undefined);
      await ctx.app.get(CatalogFill).checkBatch((job.data as { handle: string }).handle);
      await job.remove();
    }
  };
  const lastRequests = () => graph.batches.at(-1)?.requests ?? [];

  /** A Shopify store on nock: products with variants (GraphQL), and the shop's currency. */
  async function shopifyStore(products: Json[]) {
    const host = `https://${uniq('fill-')}.myshopify.com`;
    nock(host).persist().post('/admin/oauth/access_token').reply(200, { access_token: 'shpat_fill', expires_in: 86399 });
    nock(host)
      .persist()
      .post(`/admin/api/${VERSION}/graphql.json`)
      .reply(async (req: Request) => {
        const { query } = (await req.json()) as { query: string };
        if (query.includes('webhookSubscriptionCreate')) return [200, { data: { webhookSubscriptionCreate: { webhookSubscription: { id: randomUUID() }, userErrors: [] } } }];
        if (query.includes('webhookSubscriptions')) return [200, { data: { webhookSubscriptions: { nodes: [] } } }];
        if (query.includes('products(')) return [200, { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: products } } }];
        if (query.includes('shop')) return [200, { data: { shop: { name: 'Fill Shop', currencyCode: 'AED' } } }];
        return [200, { errors: [{ message: 'not faked' }] }];
      });
    const res = await api('post', '/stores', { platform: 'SHOPIFY', baseUrl: host, numberId, defaultCountry: 'AE', customerTag: 'shopify', credentials: { clientId: 'cid', clientSecret: 'shopify-client-secret-for-tests' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id as string;
  }

  const shoe = (variants: Json[]) => ({
    id: 'gid://shopify/Product/10',
    title: 'Runner',
    description: '<p>Light <b>shoe</b></p>',
    status: 'ACTIVE',
    onlineStoreUrl: 'https://shop.example/runner',
    featuredMedia: { preview: { image: { url: 'https://img.example/runner.jpg' } } },
    variants: { nodes: variants },
  });

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    admin = await signIn(ctx, 'ADMIN');
    numberId = (await seedNumber(ctx)).id;
  });

  beforeEach(async () => {
    nock.cleanAll();
    await clearCommerce(ctx);
    // Batch checks left by an earlier test belong to batches this fake never saw.
    await ctx.app.get(QueueRegistry).get(QUEUES.CATALOG).drain(true);
    graph = new FakeCommerceGraph(0).install();
    expect((await api('post', '/catalog/connection', { catalogId: FAKE_CATALOG_ID })).status).toBe(201);
  });

  afterAll(async () => {
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('fills from Shopify, one item per variant, then sends only what changed and deletes what is gone', async () => {
    const variants = [
      { id: 'gid://shopify/ProductVariant/501', title: '42', price: '150.00', availableForSale: true },
      { id: 'gid://shopify/ProductVariant/502', title: '43', price: '150', availableForSale: false },
    ];
    const storeId = await shopifyStore([shoe(variants)]);
    const saved = await api('put', '/catalog/fill', { enabled: true, storeId });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(saved.body).toMatchObject({ fillEnabled: true, fillStoreId: storeId });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'catalog.fill_changed', actorUserId: admin.userId } })).toBeGreaterThan(0);

    expect(await fill()).toEqual({ sent: 2, deleted: 0 });
    expect(lastRequests()).toEqual([
      expect.objectContaining({ method: 'CREATE', data: expect.objectContaining({ id: 'shp-501', title: 'Runner - 42', price: '150.00 AED', availability: 'in stock', condition: 'new', description: 'Light shoe', image_link: 'https://img.example/runner.jpg', link: 'https://shop.example/runner' }) }),
      expect.objectContaining({ method: 'CREATE', data: expect.objectContaining({ id: 'shp-502', availability: 'out of stock', price: '150.00 AED' }) }),
    ]);
    await runBatchChecks();
    expect((await ctx.prisma.catalogConnection.findFirstOrThrow()).fillErrors).toEqual([]);

    // Nothing changed: nothing is sent.
    const batches = graph.batches.length;
    expect(await fill()).toEqual({ sent: 0, deleted: 0 });
    expect(graph.batches.length).toBe(batches);
  });

  it('sends updates and deletions after the store changes', async () => {
    const storeId = await shopifyStore([shoe([{ id: 'gid://shopify/ProductVariant/601', title: 'Default Title', price: '99.00', availableForSale: true }])]);
    await api('put', '/catalog/fill', { enabled: true, storeId });
    await fill();
    // A product the store no longer has, with a stored hash from an earlier fill.
    await ctx.prisma.catalogProduct.create({ data: { retailerId: 'shp-999', name: 'Old', availability: 'in stock', storeRef: 'shopify:999', fillHash: createHash('sha256').update('old').digest('hex') } });
    await ctx.prisma.catalogProduct.update({ where: { retailerId: 'shp-601' }, data: { fillHash: 'x'.repeat(64) } });
    expect(await fill()).toEqual({ sent: 1, deleted: 1 });
    expect(lastRequests()).toEqual([expect.objectContaining({ method: 'UPDATE', data: expect.objectContaining({ id: 'shp-601', title: 'Runner' }) }), { method: 'DELETE', data: { id: 'shp-999' } }]);
    expect((await ctx.prisma.catalogProduct.findUniqueOrThrow({ where: { retailerId: 'shp-999' } })).removedAt).not.toBeNull();
  });

  it('keeps per-item errors from the batch status and sends those items again', async () => {
    const storeId = await shopifyStore([shoe([{ id: 'gid://shopify/ProductVariant/701', title: 'S', price: '10.00', availableForSale: true }])]);
    await api('put', '/catalog/fill', { enabled: true, storeId });
    await fill();
    const batch = graph.batches.at(-1)!;
    batch.errors.push({ id: 'shp-701', message: 'image_link is not reachable' });
    await runBatchChecks();
    const connection = await ctx.prisma.catalogConnection.findFirstOrThrow();
    expect(connection.fillErrors).toEqual([{ retailerId: 'shp-701', message: 'image_link is not reachable' }]);
    expect((await ctx.prisma.catalogProduct.findUniqueOrThrow({ where: { retailerId: 'shp-701' } })).fillHash).toBeNull();
    expect(await fill()).toEqual({ sent: 1, deleted: 0 });
  });

  it('throws on 80009 so the job backs off', async () => {
    const storeId = await shopifyStore([shoe([{ id: 'gid://shopify/ProductVariant/801', title: 'M', price: '20.00', availableForSale: true }])]);
    await api('put', '/catalog/fill', { enabled: true, storeId });
    graph.batchError = { status: 400, code: 80009, message: 'There have been too many calls to this catalog' };
    await expect(fill()).rejects.toThrow(/too many calls/);
    graph.batchError = null;
    expect(await fill()).toEqual({ sent: 1, deleted: 0 });
  });

  it('fills from WooCommerce with variations as woo-<product>-<variation>', async () => {
    const host = `https://${uniq('woo-fill-')}.example.test`;
    nock(host).persist().get('/wp-json/').reply(200, { name: 'Woo Fill' });
    nock(host).persist().get('/wp-json/wc/v3/orders').query(true).reply(200, []);
    nock(host).persist().get('/wp-json/wc/v3/webhooks').query(true).reply(200, []);
    nock(host).persist().post('/wp-json/wc/v3/webhooks').reply(201, { id: 1, status: 'active' });
    nock(host).persist().get('/wp-json/wc/v3/settings/general/woocommerce_currency').reply(200, { id: 'woocommerce_currency', value: 'AED' });
    nock(host)
      .persist()
      .get('/wp-json/wc/v3/products')
      .query(true)
      .reply(200, [
        { id: 21, type: 'simple', name: 'Cap', status: 'publish', price: '35', stock_status: 'instock', permalink: 'https://woo.example/cap', short_description: 'A cap', images: [{ src: 'https://img.example/cap.jpg' }] },
        { id: 22, type: 'variable', name: 'Tee', status: 'publish', price: '', stock_status: 'instock', permalink: 'https://woo.example/tee', short_description: '', images: [] },
      ]);
    nock(host)
      .persist()
      .get('/wp-json/wc/v3/products/22/variations')
      .query(true)
      .reply(200, [
        { id: 221, price: '60.00', stock_status: 'instock', attributes: [{ option: 'Red' }], image: { src: 'https://img.example/tee-red.jpg' } },
        { id: 222, price: '60.00', stock_status: 'outofstock', attributes: [{ option: 'Blue' }] },
      ]);
    const res = await api('post', '/stores', { platform: 'WOOCOMMERCE', baseUrl: host, numberId, defaultCountry: 'AE', customerTag: 'woo', credentials: { consumerKey: 'ck_test_0123456789abcdef', consumerSecret: 'cs_test_0123456789abcdef' } });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await api('put', '/catalog/fill', { enabled: true, storeId: res.body.id });
    expect(await fill()).toEqual({ sent: 3, deleted: 0 });
    const data = lastRequests().map((r) => (r as { data: Json }).data);
    expect(data.map((d) => [d.id, d.title, d.price, d.availability])).toEqual([
      ['woo-21-0', 'Cap', '35.00 AED', 'in stock'],
      ['woo-22-221', 'Tee - Red', '60.00 AED', 'in stock'],
      ['woo-22-222', 'Tee - Blue', '60.00 AED', 'out of stock'],
    ]);
  });

  it('refuses to fill without a store and to run when filling is off', async () => {
    const off = await api('post', '/catalog/fill/run');
    expect(off.status).toBe(409);
    expect(off.body.code).toBe('FILL_NOT_ENABLED');
    const none = await api('put', '/catalog/fill', { enabled: true, storeId: null });
    expect(none.status).toBe(409);
    expect(none.body.code).toBe('STORE_NOT_CONNECTED');
    expect(await ctx.app.get(CatalogService).connection()).not.toBeNull();
  });
});
