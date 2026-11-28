// Feature 009 (research R15, contracts/website-button.md §2): which page rule of a website chat button
// fits the page. No imports: the button script bundles this file on its own.

export type PageRuleMatch = 'EXACT' | 'PREFIX' | 'CONTAINS';

export interface PageRuleLike {
  match: PageRuleMatch;
  value: string;
  hide: boolean;
}

/** What rules are matched against: the path and query, without the fragment, lower-cased. */
export function pageKey(pathname: string, search = ''): string {
  return `${pathname}${search}`.split('#')[0]!.toLowerCase();
}

const withoutTrailingSlash = (value: string) => (value.length > 1 && value.endsWith('/') ? value.slice(0, -1) : value);

export function pageRuleMatches(rule: PageRuleLike, page: string): boolean {
  const value = rule.value.toLowerCase();
  const key = page.split('#')[0]!.toLowerCase();
  if (!value) return false;
  if (rule.match === 'EXACT') return withoutTrailingSlash(key) === withoutTrailingSlash(value);
  if (rule.match === 'PREFIX') return key.startsWith(value);
  return key.includes(value);
}

/** The first rule that fits, in the saved order, or null for the button's defaults. */
export function pickPageRule<R extends PageRuleLike>(rules: readonly R[], page: string): R | null {
  for (const rule of rules) if (pageRuleMatches(rule, page)) return rule;
  return null;
}

/** The page sent with a chat start: the path only, at most 200 characters. */
export function pagePathForCount(value: string | null | undefined): string | null {
  if (!value) return null;
  const path = value.split(/[?#]/)[0]!;
  if (!path.startsWith('/')) return null;
  return path.slice(0, 200);
}
