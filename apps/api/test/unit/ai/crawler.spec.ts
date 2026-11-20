import nock from 'nock';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CRAWLER_AGENT, crawlSite, MAX_PAGES_PER_SITE } from '../../../src/modules/ai/knowledge/crawler.js';

// T024: the website reader (research R11): robots rules, sitemap, same-host links under the start
// path, page and redirect limits, HTML only, and the 003 address checks.
const SITE = 'https://shop.example.com';
const html = (title: string, body: string) => `<html><head><title>${title}</title></head><body><main>${body}</main></body></html>`;
const page = (title: string, links: string[] = []) =>
  html(title, `<h1>${title}</h1><p>${title} text for customers.</p>${links.map((l) => `<a href="${l}">${l}</a>`).join(' ')}`);
const htmlHeaders = { 'content-type': 'text/html; charset=utf-8' };
const options = { delayMs: 0 };

function noRobotsOrSitemap(): void {
  nock(SITE).get('/robots.txt').reply(404).get('/sitemap.xml').reply(404);
}

beforeAll(() => nock.disableNetConnect());
afterEach(() => nock.cleanAll());
afterAll(() => nock.enableNetConnect());

describe('crawlSite', () => {
  it('follows only same-host links under the start path, breadth first', async () => {
    noRobotsOrSitemap();
    nock(SITE)
      .get('/help/')
      .reply(200, page('Help', ['/help/delivery', 'returns', 'https://other.example.com/help/x', '/blog/news', '/help/delivery#top']), htmlHeaders)
      .get('/help/delivery')
      .reply(200, page('Delivery', ['/help/']), htmlHeaders)
      .get('/help/returns')
      .reply(200, page('Returns'), htmlHeaders);

    const result = await crawlSite(`${SITE}/help/`, options);
    expect(result.pages.map((p) => p.url)).toEqual([`${SITE}/help/`, `${SITE}/help/delivery`, `${SITE}/help/returns`]);
    expect(result.pages[1]).toMatchObject({ title: 'Delivery' });
    expect(result.pages[1]?.blocks).toContainEqual({ kind: 'paragraph', text: 'Delivery text for customers.' });
    expect(result.stoppedAtLimit).toBe(false);
  });

  it('honours robots.txt rules for its own name', async () => {
    nock(SITE)
      .get('/robots.txt')
      .reply(200, `User-agent: ${CRAWLER_AGENT}\nDisallow: /help/private\n`, { 'content-type': 'text/plain' })
      .get('/sitemap.xml')
      .reply(404)
      .get('/help/')
      .reply(200, page('Help', ['/help/private', '/help/public']), htmlHeaders)
      .get('/help/public')
      .reply(200, page('Public'), htmlHeaders);

    const result = await crawlSite(`${SITE}/help/`, options);
    expect(result.pages.map((p) => p.url)).toEqual([`${SITE}/help/`, `${SITE}/help/public`]);
  });

  it('refuses a start address the robots rules disallow', async () => {
    nock(SITE).get('/robots.txt').reply(200, 'User-agent: *\nDisallow: /\n', { 'content-type': 'text/plain' });
    await expect(crawlSite(`${SITE}/help/`, options)).rejects.toMatchObject({ code: 'ROBOTS_DISALLOWED' });
  });

  it('uses sitemap.xml when present, keeping its pages under the start path', async () => {
    const sitemap = `<?xml version="1.0"?><urlset><url><loc>${SITE}/help/a</loc></url><url><loc>${SITE}/help/b</loc></url><url><loc>${SITE}/blog/c</loc></url><url><loc>https://other.example.com/help/d</loc></url></urlset>`;
    nock(SITE)
      .get('/robots.txt')
      .reply(404)
      .get('/sitemap.xml')
      .reply(200, sitemap, { 'content-type': 'application/xml' })
      .get('/help/')
      .reply(200, page('Help', ['/help/not-in-sitemap']), htmlHeaders)
      .get('/help/a')
      .reply(200, page('A'), htmlHeaders)
      .get('/help/b')
      .reply(200, page('B'), htmlHeaders);

    const result = await crawlSite(`${SITE}/help/`, options);
    expect(result.pages.map((p) => p.url)).toEqual([`${SITE}/help/`, `${SITE}/help/a`, `${SITE}/help/b`]);
  });

  it('stops at the page limit and says so', async () => {
    expect(MAX_PAGES_PER_SITE).toBe(100);
    noRobotsOrSitemap();
    for (let i = 0; i < 8; i += 1) nock(SITE).get(`/p/${i}`).reply(200, page(`Page ${i}`, [`/p/${i + 1}`]), htmlHeaders);
    const result = await crawlSite(`${SITE}/p/0`, { ...options, maxPages: 5 });
    expect(result.pages).toHaveLength(5);
    expect(result.stoppedAtLimit).toBe(true);
  });

  it('follows up to 3 redirects on the same host and skips others, and skips pages that are not HTML', async () => {
    noRobotsOrSitemap();
    nock(SITE)
      .get('/help/')
      .reply(200, page('Help', ['/help/old', '/help/away', '/help/loop0', '/help/file']), htmlHeaders)
      .get('/help/old')
      .reply(301, '', { location: '/help/new' })
      .get('/help/new')
      .reply(200, page('New'), htmlHeaders)
      .get('/help/away')
      .reply(302, '', { location: 'https://other.example.com/x' })
      .get('/help/loop0')
      .reply(301, '', { location: '/help/loop1' })
      .get('/help/loop1')
      .reply(301, '', { location: '/help/loop2' })
      .get('/help/loop2')
      .reply(301, '', { location: '/help/loop3' })
      .get('/help/loop3')
      .reply(301, '', { location: '/help/loop4' })
      .get('/help/file')
      .reply(200, '%PDF-1.7', { 'content-type': 'application/pdf' });

    const result = await crawlSite(`${SITE}/help/`, options);
    expect(result.pages.map((p) => p.url)).toEqual([`${SITE}/help/`, `${SITE}/help/new`]);
  });

  it('refuses http, private addresses and localhost before connecting', async () => {
    await expect(crawlSite('http://shop.example.com/', options)).rejects.toMatchObject({ code: 'NOT_HTTPS' });
    await expect(crawlSite('https://10.0.0.5/help', options)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
    await expect(crawlSite('https://localhost/help', options)).rejects.toMatchObject({ code: 'BLOCKED_ADDRESS' });
  });

  it('fails when the start page cannot be read', async () => {
    noRobotsOrSitemap();
    nock(SITE).get('/help/').reply(500);
    await expect(crawlSite(`${SITE}/help/`, options)).rejects.toMatchObject({ code: 'FETCH_FAILED' });
  });
});
