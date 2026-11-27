import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { AppConfig } from '../../../src/common/config/config.js';
import { MetaCommerceClient, isCatalogRateLimited } from '../../../src/modules/commerce/meta-commerce.client.js';
import { MetaApiError } from '../../../src/modules/meta/meta-graph.client.js';

// T017 (feature 008, contracts/meta-commerce-graph.md): catalog, commerce settings, items_batch and
// the Flows API, mapped and with errors.
const BASE = 'https://graph.facebook.test';
const V = '/v27.0';
const config = { META_GRAPH_BASE_URL: BASE, META_GRAPH_API_VERSION: 'v27.0' } as AppConfig;
const client = new MetaCommerceClient(config, { timeoutMs: 500 });
const CAT = '900000000000001';

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('MetaCommerceClient: catalog', () => {
  it('reads the WABA catalog, the catalog and pages of products', async () => {
    nock(BASE).get(`${V}/WABA1/product_catalogs`).query({ fields: 'id,name' }).matchHeader('authorization', 'Bearer tok').reply(200, { data: [{ id: CAT, name: 'Shop' }] });
    expect(await client.wabaCatalogs('tok', 'WABA1')).toEqual([{ id: CAT, name: 'Shop' }]);
    nock(BASE).get(`${V}/WABA2/product_catalogs`).query(true).reply(200, { data: [] });
    expect(await client.wabaCatalogs('tok', 'WABA2')).toEqual([]);
    nock(BASE).get(`${V}/${CAT}`).query(true).reply(200, { id: CAT, name: 'Shop' });
    expect(await client.catalog('tok', CAT)).toEqual({ id: CAT, name: 'Shop' });

    nock(BASE)
      .get(`${V}/${CAT}/products`)
      .query((q) => q.limit === '100' && String(q.fields).includes('retailer_id') && q.after === undefined)
      .reply(200, {
        data: [{ id: '7001', retailer_id: 'shp-101', name: 'Linen Shirt', price: 'AED 150.00', currency: 'AED', availability: 'in stock', review_status: 'approved', visibility: 'published', image_url: 'https://img/1.jpg' }],
        paging: { cursors: { before: 'a', after: 'b' }, next: `${BASE}${V}/${CAT}/products?after=b` },
      });
    const first = await client.products('tok', CAT);
    expect(first.next).toBe('b');
    expect(first.items[0]).toEqual({ metaId: '7001', retailerId: 'shp-101', name: 'Linen Shirt', description: null, price: 'AED 150.00', salePrice: null, currency: 'AED', imageUrl: 'https://img/1.jpg', url: null, availability: 'in stock', visibility: 'published', reviewStatus: 'approved' });
    nock(BASE).get(`${V}/${CAT}/products`).query((q) => q.after === 'b').reply(200, { data: [], paging: { cursors: { before: 'b', after: 'c' } } });
    expect((await client.products('tok', CAT, 'b')).next).toBeNull();
  });

  it('reads and sets commerce settings per number', async () => {
    nock(BASE).get(`${V}/PN1/whatsapp_commerce_settings`).reply(200, { data: [{ is_cart_enabled: true, is_catalog_visible: false, id: 'cs1' }] });
    expect(await client.commerceSettings('tok', 'PN1')).toEqual({ cartEnabled: true, catalogVisible: false });
    nock(BASE).post(`${V}/PN1/whatsapp_commerce_settings`).query({ is_cart_enabled: 'false', is_catalog_visible: 'true' }).reply(200, { success: true });
    await client.setCommerceSettings('tok', 'PN1', { cartEnabled: false, catalogVisible: true });
  });

  it('sends items_batch and reads the batch status with invalid ids', async () => {
    let sent: unknown;
    nock(BASE)
      .post(`${V}/${CAT}/items_batch`, (body) => {
        sent = body;
        return true;
      })
      .reply(200, { handles: ['H1'] });
    expect(await client.itemsBatch('tok', CAT, [{ method: 'CREATE', data: { id: 'shp-1', title: 'Shirt', price: '150.00 AED', availability: 'in stock' } }])).toBe('H1');
    expect(sent).toEqual({ item_type: 'PRODUCT_ITEM', requests: [{ method: 'CREATE', data: { id: 'shp-1', title: 'Shirt', price: '150.00 AED', availability: 'in stock' } }] });
    nock(BASE)
      .get(`${V}/${CAT}/check_batch_request_status`)
      .query({ handle: 'H1', load_ids_of_invalid_requests: 'true' })
      .reply(200, { data: [{ status: 'finished', errors: [{ line: 0, id: 'shp-2', message: 'price is required' }], ids_of_invalid_requests: ['shp-2'] }] });
    expect(await client.batchStatus('tok', CAT, 'H1')).toEqual({ status: 'finished', errors: [{ id: 'shp-2', message: 'price is required' }], invalidIds: ['shp-2'] });
  });

  it('recognises the catalog rate limit (80009)', async () => {
    nock(BASE).post(`${V}/${CAT}/items_batch`).reply(400, { error: { message: 'There have been too many calls to this Catalog account', type: 'OAuthException', code: 80009 } });
    const error = await client.itemsBatch('tok', CAT, []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetaApiError);
    expect(isCatalogRateLimited(error)).toBe(true);
    expect(isCatalogRateLimited(new MetaApiError(400, 100, undefined, 'x'))).toBe(false);
  });
});

describe('MetaCommerceClient: Flows', () => {
  it('creates and publishes a flow in one call, passing the JSON as a string', async () => {
    let sent: Record<string, unknown> = {};
    nock(BASE)
      .post(`${V}/WABA1/flows`, (body) => {
        sent = body as Record<string, unknown>;
        return true;
      })
      .reply(200, { id: 'F1', success: true });
    const flowJson = { version: '7.3', screens: [] };
    expect(await client.createFlow('tok', 'WABA1', { name: 'Booking v1', categories: ['APPOINTMENT_BOOKING'], flowJson, publish: true })).toEqual({ id: 'F1', validationErrors: [] });
    expect(sent).toEqual({ name: 'Booking v1', categories: ['APPOINTMENT_BOOKING'], flow_json: JSON.stringify(flowJson), publish: true });
  });

  it('returns Meta’s validation errors with their pointers', async () => {
    nock(BASE)
      .post(`${V}/WABA1/flows`)
      .reply(200, { id: 'F2', success: true, validation_errors: [{ error: 'INVALID_PROPERTY_VALUE', error_type: 'FLOW_JSON_ERROR', message: 'TextInput label must have at most 20 characters', pointers: [{ path: 'screens[0].layout.children[1].label' }] }] });
    expect((await client.createFlow('tok', 'WABA1', { name: 'x', categories: ['OTHER'], flowJson: {}, publish: true })).validationErrors).toEqual([
      { error: 'INVALID_PROPERTY_VALUE', message: 'TextInput label must have at most 20 characters', pointers: ['screens[0].layout.children[1].label'] },
    ]);
  });

  it('reads, deprecates and deletes flows; Graph errors become MetaApiError', async () => {
    nock(BASE).get(`${V}/F1`).query(true).reply(200, { id: 'F1', name: 'Booking v1', status: 'PUBLISHED', validation_errors: [] });
    expect(await client.flow('tok', 'F1')).toEqual({ id: 'F1', name: 'Booking v1', status: 'PUBLISHED', validationErrors: [] });
    nock(BASE).post(`${V}/F1/deprecate`).reply(200, { success: true });
    await client.deprecateFlow('tok', 'F1');
    nock(BASE).delete(`${V}/F2`).reply(400, { error: { message: 'Only draft flows can be deleted', code: 100, fbtrace_id: 't1' } });
    await expect(client.deleteFlow('tok', 'F2')).rejects.toMatchObject({ httpStatus: 400, code: 100, message: 'Only draft flows can be deleted' });
  });
});
