import { describe, expect, it } from 'vitest';
import { pageKey, pagePathForCount, pageRuleMatches, pickPageRule, type PageRuleLike } from './page-rules.js';

// T079 (feature 009 US8, contracts/website-button.md §2): page rule matching.
const rule = (match: PageRuleLike['match'], value: string, hide = false): PageRuleLike => ({ match, value, hide });

describe('page rules', () => {
  it('EXACT ignores a trailing slash; PREFIX and CONTAINS', () => {
    expect(pageRuleMatches(rule('EXACT', '/pricing'), '/pricing/')).toBe(true);
    expect(pageRuleMatches(rule('EXACT', '/pricing/'), '/pricing')).toBe(true);
    expect(pageRuleMatches(rule('EXACT', '/pricing'), '/pricing/plans')).toBe(false);
    expect(pageRuleMatches(rule('PREFIX', '/products'), '/products/lamp')).toBe(true);
    expect(pageRuleMatches(rule('PREFIX', '/products'), '/shop/products')).toBe(false);
    expect(pageRuleMatches(rule('CONTAINS', 'sale'), '/shop/summer-sale?x=1')).toBe(true);
  });

  it('matches in lower case and drops the fragment', () => {
    expect(pageKey('/Products/Lamp', '?Color=Red#reviews')).toBe('/products/lamp?color=red');
    expect(pageRuleMatches(rule('PREFIX', '/PRODUCTS'), pageKey('/products/Lamp'))).toBe(true);
    expect(pageRuleMatches(rule('CONTAINS', 'reviews'), '/products/lamp#reviews')).toBe(false);
  });

  it('takes the first match, and a hide rule stops the button', () => {
    const rules = [rule('EXACT', '/checkout', true), rule('PREFIX', '/products'), rule('CONTAINS', 'lamp')];
    expect(pickPageRule(rules, '/checkout')).toBe(rules[0]);
    expect(pickPageRule(rules, '/checkout')?.hide).toBe(true);
    expect(pickPageRule(rules, '/products/lamp')).toBe(rules[1]);
    expect(pickPageRule(rules, '/blog/lamp-guide')).toBe(rules[2]);
    expect(pickPageRule(rules, '/about')).toBeNull();
  });

  it('keeps only the path, up to 200 characters, for counting', () => {
    expect(pagePathForCount('/products/lamp?utm=x#top')).toBe('/products/lamp');
    expect(pagePathForCount(`/${'a'.repeat(300)}`)).toHaveLength(200);
    expect(pagePathForCount('https://elsewhere.example.com/x')).toBeNull();
    expect(pagePathForCount(undefined)).toBeNull();
  });
});
