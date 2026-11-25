import { expect, type Page } from '@playwright/test';
import { csrfHeaders } from './growth-helpers';

// Feature 007 e2e helpers on mock-meta (tools/mock-meta/src/ads.ts): the ads tokens, the mock ad
// account act_MOCKADS (AED, Asia/Dubai) and the page MOCKPAGE.
export const ADS_TOKEN_OK = 'mock-ads-token-ok';
export const ADS_TOKEN_NO_LEADS = 'mock-ads-token-no-leads';

/** Connects act_MOCKADS and MOCKPAGE through the API unless a working connection is saved. */
export async function ensureAdsConnected(page: Page): Promise<void> {
  const current = await page.request.get('/api/ads/connection');
  const body = (await current.json()) as { connection: { status: string; adAccountId: string } | null };
  if (body.connection?.status === 'CONNECTED' && body.connection.adAccountId === 'MOCKADS') return;
  const headers = await csrfHeaders(page);
  const session = await page.request.post('/api/ads/connection/token', { data: { accessToken: ADS_TOKEN_OK }, headers });
  expect(session.status()).toBe(201);
  const { id } = (await session.json()) as { id: string };
  const saved = await page.request.post('/api/ads/connection', { data: { sessionId: id, adAccountId: 'MOCKADS', pageId: 'MOCKPAGE' }, headers });
  expect(saved.status()).toBe(201);
}
