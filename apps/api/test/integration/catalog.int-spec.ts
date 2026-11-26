import nock from 'nock';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CatalogService } from '../../src/modules/commerce/catalog/catalog.service.js';
import { clearCommerce, seedOpenChat } from '../support/commerce.js';
import { FAKE_CATALOG_ID, FakeCommerceGraph } from '../support/fake-commerce-graph.js';
import { restoreNetwork, seedNumber, useNockLocalOnly } from '../support/fixtures.js';
import { createTestContext, signIn, type SignedInAgent, type TestContext } from '../support/test-context.js';

// T062 (feature 008 US5, FR-021 – FR-025, research R8, R10): the catalog connection per WhatsApp
// account, the first copy of 40 products with prices and unsendable ones flagged, removal on the next
// copy, a failed copy telling the admins, commerce settings, search, sending products in the window
// with the right errors, audit entries and roles, and disconnecting.

describe('Meta catalog (008 US5)', () => {
  let ctx: TestContext;
  let admin: SignedInAgent;
  let agent: SignedInAgent;
  let graph: FakeCommerceGraph;
  let number: Awaited<ReturnType<typeof seedNumber>>;
  let noCatalog: Awaited<ReturnType<typeof seedNumber>>;

  const api = (who: SignedInAgent, method: 'get' | 'post' | 'put' | 'delete', url: string, body?: object) => {
    const req = who.agent[method](`/api${url}`);
    return method === 'get' ? req : req.set('X-CSRF-Token', who.csrf).send(body ?? {});
  };
  const copy = () => ctx.app.get(CatalogService).copy();

  beforeAll(async () => {
    ctx = await createTestContext();
    useNockLocalOnly();
    await clearCommerce(ctx);
    admin = await signIn(ctx, 'ADMIN');
    agent = await signIn(ctx, 'AGENT');
    graph = new FakeCommerceGraph(40).install();
    number = await seedNumber(ctx);
    noCatalog = await seedNumber(ctx, { wabaId: `WABA_NOCAT${Date.now()}` });
    graph.wabaCatalogs.set(noCatalog.wabaId, []);
  });

  afterAll(async () => {
    nock.cleanAll();
    restoreNetwork();
    await clearCommerce(ctx);
    await ctx.close();
  });

  it('shows the catalogs per account and refuses a catalog that is not ours', async () => {
    const state = await api(admin, 'get', '/catalog/connection');
    expect(state.status, JSON.stringify(state.body)).toBe(200);
    expect(state.body.connection).toBeNull();
    expect(state.body.found).toContainEqual({ wabaId: number.wabaId, catalogs: [{ id: FAKE_CATALOG_ID, name: 'Fake Catalog' }] });
    expect(state.body.found).toContainEqual({ wabaId: noCatalog.wabaId, catalogs: [] });
    const unknown = await api(admin, 'post', '/catalog/connection', { catalogId: '123456789012' });
    expect(unknown.status).toBe(422);
    expect(unknown.body.code).toBe('CATALOG_NOT_FOUND');
    expect((await api(agent, 'get', '/catalog/connection')).status).toBe(403);
  });

  it('connects, copies 40 products with their prices and flags the ones that cannot be sent', async () => {
    const res = await api(admin, 'post', '/catalog/connection', { catalogId: FAKE_CATALOG_ID });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body).toMatchObject({ catalogId: FAKE_CATALOG_ID, name: 'Fake Catalog', syncStatus: 'RUNNING' });
    expect((await api(admin, 'post', '/catalog/connection', { catalogId: FAKE_CATALOG_ID })).status).toBe(409);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'catalog.connected', actorUserId: admin.userId } })).toBe(1);

    expect(await copy()).toEqual({ products: 40 });
    const connection = await ctx.prisma.catalogConnection.findFirstOrThrow();
    expect(connection).toMatchObject({ syncStatus: 'IDLE', productCount: 40, lastSyncError: null });
    expect(Number((await ctx.prisma.catalogProduct.findUniqueOrThrow({ where: { retailerId: 'shp-102' } })).priceMinor)).toBe(5200);
    expect(Number((await ctx.prisma.catalogProduct.findUniqueOrThrow({ where: { retailerId: 'shp-101' } })).priceMinor)).toBe(5100);

    const sendable = await api(agent, 'get', '/catalog/products?sendable=true&pageSize=100');
    expect(sendable.status).toBe(200);
    expect(sendable.body.total).toBe(36);
    const all = await api(agent, 'get', '/catalog/products?pageSize=100');
    const reasons = Object.fromEntries((all.body.items as Array<{ retailerId: string; notSendableReason: string | null }>).filter((p) => p.notSendableReason).map((p) => [p.retailerId, p.notSendableReason]));
    expect(reasons).toEqual({ 'shp-103': 'OUT_OF_STOCK', 'shp-117': 'OUT_OF_STOCK', 'shp-129': 'OUT_OF_STOCK', 'shp-133': 'REJECTED' });
  });

  it('finds products by name and SKU', async () => {
    const byName = await api(agent, 'get', '/catalog/products?search=Product%20105');
    expect(byName.body.items.map((p: { retailerId: string }) => p.retailerId)).toEqual(['shp-105']);
    const bySku = await api(agent, 'get', '/catalog/products?search=shp-11');
    expect(bySku.body.total).toBe(10);
  });

  it('marks products Meta no longer has as removed, and tells the admins when a copy fails', async () => {
    graph.products.delete('shp-140');
    await copy();
    expect((await ctx.prisma.catalogProduct.findUniqueOrThrow({ where: { retailerId: 'shp-140' } })).removedAt).not.toBeNull();
    expect((await ctx.prisma.catalogConnection.findFirstOrThrow()).productCount).toBe(39);

    graph.productsError = { status: 400, code: 190, message: 'This token cannot read the catalog' };
    await copy();
    graph.productsError = null;
    const failed = await ctx.prisma.catalogConnection.findFirstOrThrow();
    expect(failed.syncStatus).toBe('FAILED');
    expect(failed.lastSyncError).toMatch(/cannot read the catalog/);
    expect(await ctx.prisma.notification.count({ where: { type: 'CATALOG_SYNC_FAILED', userId: admin.userId } })).toBe(1);
    await copy();
    expect((await ctx.prisma.catalogConnection.findFirstOrThrow()).syncStatus).toBe('IDLE');
  });

  it('turns the cart and catalog button on and off for a number', async () => {
    const res = await api(admin, 'put', `/catalog/numbers/${number.id}/commerce-settings`, { cartEnabled: false, catalogVisible: true });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toMatchObject({ numberId: number.id, catalogConnected: true, cartEnabled: false, catalogVisible: true });
    expect(graph.settings.get(number.phoneNumberId)).toEqual({ is_cart_enabled: false, is_catalog_visible: true });
    expect(await ctx.prisma.auditLog.count({ where: { action: 'catalog.commerce_settings_changed', targetId: number.id } })).toBe(1);
    const state = await api(admin, 'get', '/catalog/connection');
    expect(state.body.numbers.find((n: { numberId: string }) => n.numberId === number.id)).toMatchObject({ catalogConnected: true, cartEnabled: false, catalogVisible: true });
  });

  it('sends one product, a list and the catalog in the window, with the right refusals', async () => {
    const { conversation } = await seedOpenChat(ctx, { numberId: number.id });
    const send = (body: object, id = conversation.id) => api(admin, 'post', `/inbox/conversations/${id}/products`, body);

    const one = await send({ kind: 'product', retailerId: 'shp-101', body: 'Our best seller' });
    expect(one.status, JSON.stringify(one.body)).toBe(201);
    const item = await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: one.body.chatItemId } });
    expect(item).toMatchObject({ kind: 'SESSION_OUT', contentType: 'PRODUCT', text: 'Our best seller' });
    expect(item.payload).toMatchObject({ catalogId: FAKE_CATALOG_ID, retailerId: 'shp-101', products: [{ retailerId: 'shp-101', name: 'Product 101', priceMinor: 5100 }] });

    const list = await send({ kind: 'list', header: 'New in', body: 'Pick one', sections: [{ title: 'Shoes', retailerIds: ['shp-101', 'shp-102'] }, { title: 'Bags', retailerIds: ['shp-104'] }] });
    expect(list.status, JSON.stringify(list.body)).toBe(201);
    expect((await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: list.body.chatItemId } })).contentType).toBe('PRODUCT_LIST');
    const untitled = await send({ kind: 'list', header: 'New in', body: 'Pick one', sections: [{ retailerIds: ['shp-101'] }, { retailerIds: ['shp-102'] }] });
    expect(untitled.status).toBe(422);

    const catalog = await send({ kind: 'catalog', body: 'Browse everything', thumbnailRetailerId: 'shp-101' });
    expect(catalog.status).toBe(201);
    expect((await ctx.prisma.chatMessage.findUniqueOrThrow({ where: { id: catalog.body.chatItemId } })).contentType).toBe('CATALOG');

    const outOfStock = await send({ kind: 'list', header: 'New in', body: 'Pick one', sections: [{ retailerIds: ['shp-101', 'shp-103', 'shp-133'] }] });
    expect(outOfStock.status).toBe(422);
    expect(outOfStock.body.code).toBe('PRODUCT_NOT_SENDABLE');
    expect(outOfStock.body.details.map((d: { field: string }) => d.field)).toEqual(['shp-103', 'shp-133']);

    const closed = await seedOpenChat(ctx, { numberId: number.id, minutesAgo: 25 * 60 });
    const late = await send({ kind: 'product', retailerId: 'shp-101' }, closed.conversation.id);
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('WINDOW_CLOSED');

    const other = await seedOpenChat(ctx, { numberId: noCatalog.id });
    const elsewhere = await send({ kind: 'product', retailerId: 'shp-101' }, other.conversation.id);
    expect(elsewhere.status).toBe(409);
    expect(elsewhere.body.code).toBe('NUMBER_NO_CATALOG');
  });

  it('disconnects: products can no longer be sent', async () => {
    const { conversation } = await seedOpenChat(ctx, { numberId: number.id });
    expect((await api(admin, 'delete', '/catalog/connection')).status).toBe(204);
    expect(await ctx.prisma.auditLog.count({ where: { action: 'catalog.disconnected', actorUserId: admin.userId } })).toBe(1);
    const res = await api(admin, 'post', `/inbox/conversations/${conversation.id}/products`, { kind: 'product', retailerId: 'shp-101' });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('CATALOG_NOT_CONNECTED');
    expect((await api(admin, 'delete', '/catalog/connection')).status).toBe(404);
  });
});
