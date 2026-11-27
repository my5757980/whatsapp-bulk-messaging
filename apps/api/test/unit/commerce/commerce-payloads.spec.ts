import { describe, expect, it } from 'vitest';
import { batchData, priceText, shopifyItems, wooItems } from '../../../src/modules/commerce/catalog/catalog-fill.js';
import { commerceInteractiveFor, flowInteractiveFor } from '../../../src/modules/inbox/messages/interactive-payload.js';
import { FLOW_TOKEN_PARAM, PRODUCTS_PARAM, buildTemplatePayload } from '../../../src/modules/sending/template-payload.builder.js';

// T064 and T070 (feature 008 US5, research R9, R10): product messages, catalog and multi-product
// template buttons, and the store fill mapping.

describe('product messages (interactive)', () => {
  it('builds product, product_list and catalog_message objects', () => {
    expect(commerceInteractiveFor('PRODUCT', 'Our best seller', { catalogId: '900', retailerId: 'shp-1', footer: 'Free delivery' })).toEqual({
      type: 'product',
      body: { text: 'Our best seller' },
      footer: { text: 'Free delivery' },
      action: { catalog_id: '900', product_retailer_id: 'shp-1' },
    });
    expect(commerceInteractiveFor('PRODUCT', null, { catalogId: '900', retailerId: 'shp-1' })).toEqual({ type: 'product', action: { catalog_id: '900', product_retailer_id: 'shp-1' } });
    expect(commerceInteractiveFor('PRODUCT_LIST', 'Pick one', { catalogId: '900', header: 'New in', sections: [{ title: 'Shoes', retailerIds: ['a', 'b'] }, { title: 'Bags', retailerIds: ['c'] }] })).toEqual({
      type: 'product_list',
      header: { type: 'text', text: 'New in' },
      body: { text: 'Pick one' },
      action: {
        catalog_id: '900',
        sections: [
          { title: 'Shoes', product_items: [{ product_retailer_id: 'a' }, { product_retailer_id: 'b' }] },
          { title: 'Bags', product_items: [{ product_retailer_id: 'c' }] },
        ],
      },
    });
    expect(commerceInteractiveFor('CATALOG', 'Browse', { catalogId: '900', thumbnailRetailerId: 'shp-1' })).toEqual({
      type: 'catalog_message',
      body: { text: 'Browse' },
      action: { name: 'catalog_message', parameters: { thumbnail_product_retailer_id: 'shp-1' } },
    });
  });
});

describe('WhatsApp Forms (US7)', () => {
  it('sends a form as an interactive flow message with its token', () => {
    expect(flowInteractiveFor('Book a visit', { flowId: 'FLOW1', cta: 'Book now', token: 'wf1.x.y', header: 'Bookings' })).toEqual({
      type: 'flow',
      header: { type: 'text', text: 'Bookings' },
      body: { text: 'Book a visit' },
      action: { name: 'flow', parameters: { flow_message_version: '3', flow_id: 'FLOW1', flow_cta: 'Book now', flow_token: 'wf1.x.y', flow_action: 'navigate', flow_action_payload: { screen: 'S1' } } },
    });
  });

  it('sends a template form button with the recipient token', () => {
    const payload = buildTemplatePayload({
      to: '+971501234567',
      template: { name: 'book', language: 'en_US', parameterFormat: 'POSITIONAL', components: [{ type: 'BODY', text: 'Book your visit' }, { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'Book', flow_id: 'FLOW1' } as never] }] },
      params: { [FLOW_TOKEN_PARAM]: 'wf1.a.b' },
    });
    expect(payload.template.components).toEqual([{ type: 'button', sub_type: 'flow', index: '0', parameters: [{ type: 'action', action: { flow_token: 'wf1.a.b' } }] }]);
  });
});

describe('catalog and multi-product templates', () => {
  const template = (type: 'CATALOG' | 'MPM') => ({
    name: 'catalog_promo',
    language: 'en_US',
    parameterFormat: 'POSITIONAL' as const,
    components: [
      { type: 'BODY', text: 'Hi {{1}}, see our new range.' },
      { type: 'BUTTONS', buttons: [{ type, text: 'View' }] },
    ],
  });
  const choices = JSON.stringify({ thumbnailRetailerId: 'shp-1', sections: [{ title: 'New', retailerIds: ['shp-1', 'shp-2'] }] });

  it('sends the catalog button with its thumbnail', () => {
    const payload = buildTemplatePayload({ to: '+971501234567', template: template('CATALOG'), params: { 'BODY.1': 'Sara', [PRODUCTS_PARAM]: choices } });
    expect(payload.template.components).toEqual([
      { type: 'body', parameters: [{ type: 'text', text: 'Sara' }] },
      { type: 'button', sub_type: 'CATALOG', index: '0', parameters: [{ type: 'action', action: { thumbnail_product_retailer_id: 'shp-1' } }] },
    ]);
  });

  it('sends the multi-product button with its sections', () => {
    const payload = buildTemplatePayload({ to: '+971501234567', template: template('MPM'), params: { 'BODY.1': 'Sara', [PRODUCTS_PARAM]: choices } });
    expect(payload.template.components.at(-1)).toEqual({
      type: 'button',
      sub_type: 'mpm',
      index: '0',
      parameters: [{ type: 'action', action: { thumbnail_product_retailer_id: 'shp-1', sections: [{ title: 'New', product_items: [{ product_retailer_id: 'shp-1' }, { product_retailer_id: 'shp-2' }] }] } }],
    });
  });
});

describe('store fill mapping', () => {
  it('prices as "150.00 AED" and refuses missing prices', () => {
    expect(priceText('150', 'aed')).toBe('150.00 AED');
    expect(priceText(9.5, 'usd')).toBe('9.50 USD');
    expect(priceText(null, 'aed')).toBeNull();
  });

  it('maps Shopify variants and WooCommerce variations to retailer ids', () => {
    const shopify = shopifyItems(
      [
        {
          id: 'gid://shopify/Product/1',
          title: 'Runner',
          description: 'Fast',
          status: 'ACTIVE',
          onlineStoreUrl: null,
          featuredMedia: { preview: { image: { url: 'https://img/1.jpg' } } },
          variants: { nodes: [{ id: 'gid://shopify/ProductVariant/11', title: 'Default Title', price: '20.00', availableForSale: true }] },
        },
      ],
      'aed',
    );
    expect(shopify).toEqual([{ retailerId: 'shp-11', storeRef: 'shopify:11', title: 'Runner', description: 'Fast', availability: 'in stock', price: '20.00 AED', link: null, imageLink: 'https://img/1.jpg' }]);
    const woo = wooItems([{ product: { id: 5, name: 'Tee', status: 'draft', permalink: 'https://w/t', images: [] }, variations: [{ id: 51, price: '10', stock_status: 'instock', attributes: [{ option: 'S' }] }] }], 'aed');
    expect(woo).toEqual([{ retailerId: 'woo-5-51', storeRef: 'woo:5:51', title: 'Tee - S', description: '', availability: 'out of stock', price: '10.00 AED', link: 'https://w/t', imageLink: null }]);
  });

  it('hashes the batch data, so an unchanged item has the same hash', () => {
    const item = { retailerId: 'shp-1', storeRef: 'shopify:1', title: 'A', description: '', availability: 'in stock' as const, price: '1.00 AED', link: null, imageLink: null };
    const a = batchData(item, 'Shop');
    expect(a.data).toEqual({ id: 'shp-1', title: 'A', description: 'A', availability: 'in stock', condition: 'new', price: '1.00 AED', brand: 'Shop' });
    expect(batchData(item, 'Shop').hash).toBe(a.hash);
    expect(batchData({ ...item, price: '2.00 AED' }, 'Shop').hash).not.toBe(a.hash);
  });
});
