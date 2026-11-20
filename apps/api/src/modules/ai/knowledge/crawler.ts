import { request } from 'node:https';
import { isIP } from 'node:net';
import { AI_LIMITS, type TextBlock } from '@wbm/shared';
import robotsParserModule from 'robots-parser';
import { ApiCallError, createSafeLookup, isBlockedAddress } from '../../flows/steps/api-client.js';
import { KnowledgeError } from './extract/errors.js';
import { htmlBlocks } from './extract/html.js';

// The website reader for knowledge sources (research R11, T036). HTTPS only, through the 003 safe
// lookup (names that resolve to private or reserved addresses are refused at connect time), robots
// rules honoured under our own name, sitemap.xml first, otherwise same-host links under the start
// path, breadth first. One request at a time, at most 100 pages, 10 s and 2 MB per page.

export const CRAWLER_AGENT = 'WBM-KnowledgeReader';
export const MAX_PAGES_PER_SITE = AI_LIMITS.pagesPerSite;
const PAGE_TIMEOUT_MS = 10_000;
const PAGE_MAX_BYTES = 2 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_CHILD_SITEMAPS = 5;
const SKIPPED_FILES = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|gz|jpe?g|png|gif|webp|svg|ico|mp4|mp3|wav|avi|mov|css|js|json|xml|txt|csv)$/i;

export interface CrawledPage {
  url: string;
  title: string;
  blocks: TextBlock[];
}

export interface CrawlResult {
  pages: CrawledPage[];
  /** True when more pages were waiting at the page limit (shown as a note on the source). */
  stoppedAtLimit: boolean;
}

export interface CrawlOptions {
  maxPages?: number;
  /** Pause between requests (500 ms by default, to be polite). */
  delayMs?: number;
}

interface Fetched {
  status: number;
  contentType: string;
  location: string | null;
  body: Buffer;
}

const safeLookup = createSafeLookup();

interface Robots {
  isAllowed(url: string, userAgent?: string): boolean | undefined;
  getSitemaps(): string[];
}

// robots-parser is CommonJS with an ESM-style declaration: take the function whichever way it loads.
const robotsParser = ((robotsParserModule as unknown as { default?: unknown }).default ?? robotsParserModule) as unknown as (url: string, text: string) => Robots;

/** HTTPS only, and no private address literals or localhost (checked again by the lookup). */
function checkAddress(url: URL): void {
  if (url.protocol !== 'https:') throw new KnowledgeError('NOT_HTTPS');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if ((isIP(host) && isBlockedAddress(host)) || host === 'localhost' || host.endsWith('.localhost')) throw new KnowledgeError('BLOCKED_ADDRESS');
}

function fetchOnce(url: URL, accept: string): Promise<Fetched> {
  return new Promise<Fetched>((resolve, reject) => {
    let settled = false;
    const finish = (error: KnowledgeError | null, result?: Fetched) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const req = request(url, { method: 'GET', headers: { 'user-agent': `${CRAWLER_AGENT}/1.0`, accept }, lookup: safeLookup }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > PAGE_MAX_BYTES) {
          finish(new KnowledgeError('TOO_LARGE'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on('error', () => finish(new KnowledgeError('FETCH_FAILED')));
      res.on('end', () =>
        finish(null, {
          status: res.statusCode ?? 0,
          contentType: String(res.headers['content-type'] ?? ''),
          location: typeof res.headers.location === 'string' ? res.headers.location : null,
          body: Buffer.concat(chunks),
        }),
      );
    });
    const timer = setTimeout(() => {
      finish(new KnowledgeError('FETCH_FAILED'));
      req.destroy();
    }, PAGE_TIMEOUT_MS);
    req.on('error', (error) => finish(error instanceof ApiCallError && error.reason === 'BLOCKED_ADDRESS' ? new KnowledgeError('BLOCKED_ADDRESS') : new KnowledgeError('FETCH_FAILED')));
    req.end();
  });
}

/** Follows up to 3 redirects on the same host; null for other hosts or longer chains. */
async function fetchFollowing(start: URL, accept: string): Promise<{ url: URL; fetched: Fetched } | null> {
  let url = start;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const fetched = await fetchOnce(url, accept);
    if (fetched.status >= 300 && fetched.status < 400 && fetched.location) {
      const next = new URL(fetched.location, url);
      if (next.host !== start.host) return null;
      checkAddress(next);
      url = next;
      continue;
    }
    return { url, fetched };
  }
  return null;
}

/** The URL without its fragment or query, so the same page is read once. */
function normalise(url: URL): string {
  return `${url.origin}${url.pathname}`;
}

function underPrefix(url: URL, start: URL, prefix: string): boolean {
  return url.protocol === 'https:' && url.host === start.host && url.pathname.startsWith(prefix) && !SKIPPED_FILES.test(url.pathname);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function readRobots(start: URL): Promise<Robots | null> {
  const robotsUrl = new URL('/robots.txt', start.origin);
  try {
    const result = await fetchFollowing(robotsUrl, 'text/plain');
    if (!result || result.fetched.status !== 200) return null;
    return robotsParser(robotsUrl.href, result.fetched.body.toString('utf8'));
  } catch (error) {
    if (error instanceof KnowledgeError && error.code === 'BLOCKED_ADDRESS') throw error;
    return null;
  }
}

const LOC = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;

async function readSitemap(start: URL, prefix: string, robots: Robots | null): Promise<URL[]> {
  const declared = robots?.getSitemaps() ?? [];
  const candidates = declared.length ? declared : [new URL('/sitemap.xml', start.origin).href];
  const found: URL[] = [];
  const visit = async (address: string, depth: number): Promise<void> => {
    let url: URL;
    try {
      url = new URL(address);
      checkAddress(url);
    } catch {
      return;
    }
    const result = await fetchFollowing(url, 'application/xml').catch(() => null);
    if (!result || result.fetched.status !== 200) return;
    const xml = result.fetched.body.toString('utf8');
    const locations = [...xml.matchAll(LOC)].map((m) => m[1]!);
    if (/<sitemapindex/i.test(xml)) {
      if (depth > 0) return;
      for (const child of locations.slice(0, MAX_CHILD_SITEMAPS)) await visit(child, depth + 1);
      return;
    }
    for (const location of locations) {
      try {
        const page = new URL(location);
        if (underPrefix(page, start, prefix)) found.push(page);
      } catch {
        // not a URL
      }
    }
  };
  for (const candidate of candidates) {
    await visit(candidate, 0);
    if (found.length) break;
  }
  return found;
}

export async function crawlSite(startAddress: string, options: CrawlOptions = {}): Promise<CrawlResult> {
  const maxPages = options.maxPages ?? MAX_PAGES_PER_SITE;
  const delayMs = options.delayMs ?? 500;
  let start: URL;
  try {
    start = new URL(startAddress);
  } catch {
    throw new KnowledgeError('FETCH_FAILED', 'The address is not a valid URL.');
  }
  checkAddress(start);
  const prefix = start.pathname.slice(0, start.pathname.lastIndexOf('/') + 1) || '/';

  const robots = await readRobots(start);
  const allowed = (url: URL) => !robots || robots.isAllowed(url.href, CRAWLER_AGENT) !== false;
  if (!allowed(start)) throw new KnowledgeError('ROBOTS_DISALLOWED');

  const fromSitemap = await readSitemap(start, prefix, robots);
  const followLinks = fromSitemap.length === 0;
  const queue: URL[] = [start, ...fromSitemap];
  const seen = new Set<string>();
  const queued = new Set<string>(queue.map(normalise));
  const pages: CrawledPage[] = [];
  let requests = 0;

  while (queue.length && pages.length < maxPages) {
    const url = queue.shift()!;
    const key = normalise(url);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!allowed(url)) continue;
    const isStart = pages.length === 0 && key === normalise(start);
    if (requests > 0 && delayMs > 0) await sleep(delayMs);
    requests += 1;

    let result: Awaited<ReturnType<typeof fetchFollowing>>;
    try {
      result = await fetchFollowing(url, 'text/html');
    } catch (error) {
      if (isStart) throw error instanceof KnowledgeError ? error : new KnowledgeError('FETCH_FAILED');
      continue;
    }
    const ok = result && result.fetched.status === 200 && result.fetched.contentType.toLowerCase().includes('text/html');
    if (!ok) {
      if (isStart) throw new KnowledgeError('FETCH_FAILED');
      continue;
    }
    const finalKey = normalise(result!.url);
    if (finalKey !== key && seen.has(finalKey)) continue;
    seen.add(finalKey);

    const parsed = htmlBlocks(result!.fetched.body.toString('utf8'));
    pages.push({ url: finalKey, title: parsed.title ?? finalKey, blocks: parsed.blocks });

    if (!followLinks) continue;
    for (const href of parsed.links) {
      let link: URL;
      try {
        link = new URL(href, result!.url);
      } catch {
        continue;
      }
      const linkKey = normalise(link);
      if (!underPrefix(link, start, prefix) || seen.has(linkKey) || queued.has(linkKey)) continue;
      queued.add(linkKey);
      queue.push(new URL(linkKey));
    }
  }

  return { pages, stoppedAtLimit: pages.length >= maxPages && queue.some((u) => !seen.has(normalise(u))) };
}
