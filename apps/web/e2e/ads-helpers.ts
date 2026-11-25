import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { csrfHeaders } from './growth-helpers';

export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

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

/** An image in the media library for ad versions (samples/media/photo.jpg). */
export async function uploadAdImage(page: Page, displayName: string): Promise<string> {
  const upload = await page.request.post('/api/media-library', {
    headers: await csrfHeaders(page),
    multipart: { file: { name: displayName, mimeType: 'image/jpeg', buffer: readFileSync(`${REPO_ROOT}samples/media/photo.jpg`) }, displayName },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  return ((await upload.json()) as { id: string }).id;
}

/** A chat ad made and submitted through the API; returns its id. */
export async function launchChatAd(page: Page, input: { name: string; numberId: string; mediaAssetId: string; primaryText: string; flowId?: string | null; tagId?: string | null }): Promise<string> {
  const headers = await csrfHeaders(page);
  const created = await page.request.post('/api/ads/campaigns', {
    headers,
    data: {
      name: input.name,
      goal: 'CHATS',
      numberId: input.numberId,
      prefilledMessage: 'Hi, I saw your ad',
      targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country', countryCode: 'AE' }], ageMin: 25, ageMax: 45 },
      placements: { auto: true },
      dailyBudgetMinor: 5000,
      startAt: new Date().toISOString(),
      flowId: input.flowId ?? null,
      tagId: input.tagId ?? null,
      versions: [{ mediaAssetId: input.mediaAssetId, primaryText: input.primaryText, headline: 'Chat with us', callToAction: 'WHATSAPP_MESSAGE' }],
    },
  });
  expect(created.status(), await created.text()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const submitted = await page.request.post(`/api/ads/campaigns/${id}/submit`, { headers });
  expect(submitted.status(), await submitted.text()).toBe(200);
  return id;
}
