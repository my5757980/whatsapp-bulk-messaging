import { expect, test } from '@playwright/test';
import { ensureAdsConnected, launchChatAd, uploadAdImage } from './ads-helpers';
import { connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T027 (feature 007, quickstart US2 row): on mock-meta, a chat ad built in the builder goes from In
// review to Active; a version with "reject-me" shows Rejected with Meta's reason, and after an edit it
// goes back to review and becomes Active; a budget under Meta's minimum is refused with the minimum.
test('US2: builds and launches a chat ad, then fixes and resubmits a rejected version', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = String(Date.now()).slice(-6);
  await signInAsAdmin(page);
  await ensureAdsConnected(page);
  const number = await connectNumber(page, 'Ads US2', suffix);
  const numberRow = ((await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; label: string }>).find((n) => n.label === number.label)!;
  const imageName = `ad-photo-${suffix}.jpg`;
  const imageId = await uploadAdImage(page, imageName);

  // 1. The builder: a chat ad for the UAE, ages 25–45, automatic placements, AED 50 a day, one image.
  await page.goto('/ads/new');
  await page.getByLabel('Campaign name').fill(`Spring sale ${suffix}`);
  await page.getByLabel('WhatsApp number').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await page.getByLabel('Pre-filled message').fill('Hi, I saw your ad');
  await page.getByLabel('Places').fill('United');
  await page.getByRole('button', { name: 'Add United Arab Emirates' }).click();
  await page.getByLabel('Age from').fill('25');
  await page.getByLabel('Age to').fill('45');
  await page.getByRole('button', { name: 'Estimate audience' }).click();
  await expect(page.getByTestId('ad-estimate')).toContainText('Minimum daily budget: AED');
  await page.getByLabel('Daily budget (AED)').fill('50');
  await page.getByLabel('Image or video').selectOption({ label: `${imageName} (image)` });
  await page.getByLabel('Main text').fill('Spring sale: 30% off shoes');
  await page.getByLabel('Headline').fill('Chat with us');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/ads\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('ad-status')).toHaveText(/In review|Active/);
  await expect(page.getByTestId('ad-status')).toHaveText('Active', { timeout: 60_000 });

  // 2. A version with "reject-me" is rejected with Meta's reason, then fixed and resubmitted.
  const rejectedId = await launchChatAd(page, { name: `Reject test ${suffix}`, numberId: numberRow.id, mediaAssetId: imageId, primaryText: 'Guaranteed results reject-me' });
  await page.goto(`/ads/${rejectedId}`);
  await expect(page.getByTestId('ad-status')).toHaveText('Rejected', { timeout: 60_000 });
  await expect(page.getByTestId('ad-feedback-1')).toContainText('Ads may not promise results');
  await page.getByRole('button', { name: 'Edit version 1' }).click();
  await page.getByLabel('Main text').fill('Spring sale on shoes');
  await page.getByRole('button', { name: 'Save version' }).click();
  await expect(page.getByText('Edited, not submitted')).toBeVisible();
  await page.getByRole('button', { name: 'Submit edited versions' }).click();
  await expect(page.getByTestId('ad-status')).toHaveText('Active', { timeout: 60_000 });

  // 3. A budget under Meta's minimum (AED 4.00 on mock-meta) is refused with the minimum.
  const headers = await csrfHeaders(page);
  const low = await page.request.post('/api/ads/campaigns', {
    headers,
    data: {
      name: `Low budget ${suffix}`,
      goal: 'CHATS',
      numberId: numberRow.id,
      prefilledMessage: 'Hi',
      targeting: { locations: [{ key: 'AE', name: 'United Arab Emirates', type: 'country', countryCode: 'AE' }] },
      placements: { auto: true },
      dailyBudgetMinor: 300,
      startAt: new Date().toISOString(),
      versions: [{ mediaAssetId: imageId, primaryText: 'Hello', headline: 'Hello', callToAction: 'WHATSAPP_MESSAGE' }],
    },
  });
  expect(low.status()).toBe(201);
  const refused = await page.request.post(`/api/ads/campaigns/${((await low.json()) as { id: string }).id}/submit`, { headers });
  expect(refused.status()).toBe(422);
  expect(JSON.stringify(await refused.json())).toContain('AED 4.00');
});
