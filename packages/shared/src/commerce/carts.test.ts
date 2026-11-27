import { describe, expect, it } from 'vitest';
import { buildCart, type CatalogCopy } from './carts.js';

// T011 (feature 008, research R11): carts from order messages, with the cart's own prices and warnings.
const catalog = new Map<string, CatalogCopy>([
  ['shp-101', { name: 'Linen Shirt 101', priceMinor: 7500, currency: 'aed', removed: false }],
  ['shp-102', { name: 'Abaya 102', priceMinor: 10000, currency: 'aed', removed: false }],
  ['shp-109', { name: 'Old item', priceMinor: 5000, currency: 'aed', removed: true }],
]);
const lookup = (id: string) => catalog.get(id);

describe('buildCart', () => {
  it('totals the cart in minor units from decimal item prices, with names from the copy', () => {
    const cart = buildCart([
      { retailerId: 'shp-101', quantity: 2, itemPrice: 75, currency: 'AED' },
      { retailerId: 'shp-102', quantity: 1, itemPrice: 100, currency: 'AED' },
    ], lookup, 'aed');
    expect(cart).toEqual({
      currency: 'aed',
      totalMinor: 25000,
      warnings: [],
      items: [
        { retailerId: 'shp-101', name: 'Linen Shirt 101', quantity: 2, itemPriceMinor: 7500, currency: 'aed' },
        { retailerId: 'shp-102', name: 'Abaya 102', quantity: 1, itemPriceMinor: 10000, currency: 'aed' },
      ],
    });
  });

  it('keeps the cart price and warns when it differs from the catalog copy', () => {
    const cart = buildCart([{ retailerId: 'shp-101', quantity: 1, itemPrice: 70.5, currency: 'AED' }], lookup, 'aed');
    expect(cart.totalMinor).toBe(7050);
    expect(cart.warnings).toEqual([{ kind: 'PRICE_CHANGED', retailerId: 'shp-101', detail: 'cart AED 70.50, catalog AED 75.00' }]);
  });

  it('warns about products missing from the copy, or removed from it', () => {
    const cart = buildCart([
      { retailerId: 'shp-999', quantity: 1, itemPrice: 10, currency: 'AED' },
      { retailerId: 'shp-109', quantity: 1, itemPrice: 50, currency: 'AED' },
    ], lookup, 'aed');
    expect(cart.warnings.map((w) => [w.kind, w.retailerId])).toEqual([['NOT_IN_CATALOG', 'shp-999'], ['NOT_IN_CATALOG', 'shp-109']]);
    expect(cart.items[0]?.name).toBeNull();
  });

  it('warns about another currency and mixed currencies', () => {
    expect(buildCart([{ retailerId: 'shp-101', quantity: 1, itemPrice: 20, currency: 'USD' }], lookup, 'aed').warnings.map((w) => w.kind)).toEqual(['CURRENCY']);
    const mixed = buildCart([
      { retailerId: 'shp-101', quantity: 1, itemPrice: 75, currency: 'AED' },
      { retailerId: 'shp-102', quantity: 1, itemPrice: 30, currency: 'USD' },
    ], lookup, 'aed');
    expect(mixed.warnings.map((w) => w.kind)).toContain('MIXED_CURRENCY');
    expect(mixed.currency).toBe('aed');
  });

  it('treats a missing or broken quantity as one', () => {
    const cart = buildCart([{ retailerId: 'shp-101', quantity: 0, itemPrice: 75, currency: 'AED' }], lookup, 'aed');
    expect(cart.items[0]?.quantity).toBe(1);
    expect(cart.totalMinor).toBe(7500);
  });
});
