import { describe, expect, it } from 'vitest';
import { COMMERCE_LIMITS, isSendableProduct, notSendableReason, parseCatalogPrice, productListProblem } from './catalog.js';

// T011 (feature 008, research R8, R10): catalog prices, sendable products and product list limits.
describe('parseCatalogPrice', () => {
  it('reads the price formats Meta returns', () => {
    expect(parseCatalogPrice('AED 150.00', 'AED')).toBe(15000);
    expect(parseCatalogPrice('AED1,234.50', 'AED')).toBe(123450);
    expect(parseCatalogPrice('1,234.50 AED', 'AED')).toBe(123450);
    expect(parseCatalogPrice('150 AED', 'AED')).toBe(15000);
    expect(parseCatalogPrice('د.إ.‏ 150.00', 'AED')).toBe(15000);
    expect(parseCatalogPrice('$10.00', 'usd')).toBe(1000);
    expect(parseCatalogPrice('KWD 1.250', 'KWD')).toBe(1250);
  });

  it('returns null when there is no price to read', () => {
    expect(parseCatalogPrice('', 'AED')).toBeNull();
    expect(parseCatalogPrice(null, 'AED')).toBeNull();
    expect(parseCatalogPrice('free', 'AED')).toBeNull();
    expect(parseCatalogPrice('AED 150.00', null)).toBeNull();
  });
});

describe('sendable products', () => {
  const product = { availability: 'in stock', removedAt: null, reviewStatus: 'approved', visibility: 'published' };
  it('sends products in stock or available for order', () => {
    expect(isSendableProduct(product)).toBe(true);
    expect(isSendableProduct({ ...product, availability: 'available for order' })).toBe(true);
    expect(isSendableProduct({ ...product, availability: 'IN_STOCK' })).toBe(true);
    expect(isSendableProduct({ ...product, reviewStatus: null, visibility: null })).toBe(true);
  });

  it('names why a product cannot be sent', () => {
    expect(notSendableReason({ ...product, availability: 'out of stock' })).toBe('OUT_OF_STOCK');
    expect(notSendableReason({ ...product, availability: 'discontinued' })).toBe('OUT_OF_STOCK');
    expect(notSendableReason({ ...product, removedAt: new Date() })).toBe('REMOVED');
    expect(notSendableReason({ ...product, reviewStatus: 'rejected' })).toBe('REJECTED');
    expect(notSendableReason({ ...product, visibility: 'staging' })).toBe('HIDDEN');
    expect(notSendableReason(product)).toBeNull();
  });
});

describe('productListProblem', () => {
  const ids = (n: number, start = 0) => Array.from({ length: n }, (_, i) => `shp-${start + i}`);
  it('allows 1–10 sections and 1–30 products in total', () => {
    expect(productListProblem([{ retailerIds: ids(3) }])).toBeNull();
    expect(productListProblem([{ title: 'Shirts', retailerIds: ids(15) }, { title: 'Abayas', retailerIds: ids(15, 20) }])).toBeNull();
    expect(productListProblem([])).toMatch(/section/);
    expect(productListProblem(Array.from({ length: 11 }, (_, i) => ({ title: `S${i}`, retailerIds: ids(1, i) })))).toMatch(/10/);
    expect(productListProblem([{ title: 'A', retailerIds: ids(16) }, { title: 'B', retailerIds: ids(15, 20) }])).toMatch(/30/);
  });

  it('needs a product in each section and titles of up to 24 characters when there are several', () => {
    expect(productListProblem([{ title: 'A', retailerIds: [] }, { title: 'B', retailerIds: ids(1) }])).toMatch(/each section/);
    expect(productListProblem([{ retailerIds: ids(1) }, { title: 'B', retailerIds: ids(1, 5) }])).toMatch(/title/);
    expect(productListProblem([{ title: 'x'.repeat(COMMERCE_LIMITS.sectionTitle + 1), retailerIds: ids(1) }, { title: 'B', retailerIds: ids(1, 5) }])).toMatch(/24/);
    expect(productListProblem([{ title: 'A', retailerIds: ['shp-1', 'shp-1'] }])).toMatch(/twice/);
  });
});
