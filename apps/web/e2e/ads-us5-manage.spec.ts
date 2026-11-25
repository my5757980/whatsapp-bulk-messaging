import { expect, test } from '@playwright/test';
import { ensureAdsConnected, launchChatAd, uploadAdImage } from './ads-helpers';
import { connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T046 (feature 007, quickstart US5 row): on mock-meta, a running ad is paused and resumed, its budget is
// raised, a raise over a low monthly cap is refused with the amount left, and it is duplicated as a draft.
test('US5: pauses, resumes, raises the budget within the cap and duplicates', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = String(Date.now()).slice(-6);
  await signInAsAdmin(page);
  await ensureAdsConnected(page);
  const number = await connectNumber(page, 'Ads US5', suffix);
  const numberId = ((await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; label: string }>).find((n) => n.label === number.label)!.id;
  const imageId = await uploadAdImage(page, `ad-us5-${suffix}.jpg`);
  const campaignId = await launchChatAd(page, { name: `Manage ${suffix}`, numberId, mediaAssetId: imageId, primaryText: 'Spring sale on shoes' });

  await page.goto(`/ads/${campaignId}`);
  const status = page.getByTestId('ad-status');
  await expect(status).toHaveText('Active', { timeout: 60_000 });

  // 1. Pause and resume at Meta.
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await expect(status).toHaveText('Paused');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(status).toHaveText('Active');

  // 2. Raise the daily budget.
  await page.getByLabel('Daily budget (AED)').fill('60');
  await page.getByRole('button', { name: 'Save budget and dates' }).click();
  await expect(page.getByText('Saved at Meta')).toBeVisible();
  await expect(page.getByText(/AED.60\.00 a day/)).toBeVisible();

  // 3. A raise that could pass a low monthly cap is refused with the amount left.
  const headers = await csrfHeaders(page);
  expect((await page.request.put('/api/ads/connection/spend-cap', { headers, data: { monthlyCapMinor: 100 } })).status()).toBe(200);
  try {
    await page.getByLabel('Daily budget (AED)').fill('70');
    await page.getByRole('button', { name: 'Save budget and dates' }).click();
    await expect(page.getByText(/monthly spending cap of AED.1\.00/)).toBeVisible();
  } finally {
    await page.request.put('/api/ads/connection/spend-cap', { headers, data: { monthlyCapMinor: null } });
  }

  // 4. Duplicate as a draft.
  await page.getByRole('button', { name: 'Duplicate' }).click();
  await expect(page.getByRole('heading', { name: `Manage ${suffix} (copy)` })).toBeVisible();
  await expect(status).toHaveText('Draft');
});
