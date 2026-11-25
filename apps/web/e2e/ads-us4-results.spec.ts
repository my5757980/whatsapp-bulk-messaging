import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { REPO_ROOT, ensureAdsConnected, launchChatAd, uploadAdImage } from './ads-helpers';
import { connectNumber, signInAsAdmin } from './growth-helpers';

// T041 (feature 007, quickstart US4 row): on mock-meta, an active chat ad gets a chat from its ad; the
// campaign's results show Meta's numbers (read soon after the ad became active), chats started 1 and
// the cost per chat, and the CSV export downloads.
test('US4: results show Meta’s numbers, the chats from the ad and the cost per chat', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = String(Date.now()).slice(-6);
  await signInAsAdmin(page);
  await ensureAdsConnected(page);
  const number = await connectNumber(page, 'Ads US4', suffix);
  const numberId = ((await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; label: string }>).find((n) => n.label === number.label)!.id;
  const imageId = await uploadAdImage(page, `ad-us4-${suffix}.jpg`);
  const campaignId = await launchChatAd(page, { name: `Results ${suffix}`, numberId, mediaAssetId: imageId, primaryText: 'Spring sale on shoes' });
  const campaign = async () => (await (await page.request.get(`/api/ads/campaigns/${campaignId}`)).json()) as { status: string; versions: Array<{ metaAdId: string }> };
  await expect.poll(async () => (await campaign()).status, { timeout: 60_000 }).toBe('ACTIVE');

  execSync(`npm run mock:inbound -- --from +97155${suffix}5 --name "Results ${suffix}" --phone-number-id ${number.phoneNumberId} --text "Hi, I saw your ad" --referral-ad ${(await campaign()).versions[0]!.metaAdId}`, {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });

  await page.goto(`/ads/${campaignId}`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('ad-result-chats')).toHaveText('1', { timeout: 3_000 });
    await expect(page.getByTestId('ad-result-impressions')).not.toHaveText('0', { timeout: 3_000 });
  }).toPass({ timeout: 120_000 });
  await expect(page.getByTestId('ad-result-new-contacts')).toHaveText('1');
  await expect(page.getByTestId('ad-result-spend')).toContainText('AED');
  await expect(page.getByTestId('ad-result-cost-per-chat')).toContainText('AED');

  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Export CSV' }).click();
  expect((await download).suggestedFilename()).toMatch(/^ad-results-.+\.csv$/);
});
