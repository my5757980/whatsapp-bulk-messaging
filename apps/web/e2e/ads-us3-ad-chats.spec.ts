import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { REPO_ROOT, ensureAdsConnected, launchChatAd, uploadAdImage } from './ads-helpers';
import { connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T034 (feature 007, quickstart US3 row): on mock-meta, an active chat ad gets the flow "Welcome" and a
// tag; a customer message with the ad's referral shows the ad card in live chat with the free window,
// the flow's reply and the tag; a message from an unknown ad is listed under Other ads.
test('US3: a chat from an ad shows the ad, runs the campaign flow and tags the contact', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = String(Date.now()).slice(-6);
  const tagName = `from-ad-${suffix}`;
  const welcome = `Welcome from the ad ${suffix}!`;
  const headline = `Spring sale ${suffix}`;
  await signInAsAdmin(page);
  await ensureAdsConnected(page);
  const number = await connectNumber(page, 'Ads US3', suffix);
  const headers = await csrfHeaders(page);
  const numberId = ((await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; label: string }>).find((n) => n.label === number.label)!.id;
  const imageId = await uploadAdImage(page, `ad-us3-${suffix}.jpg`);

  // The tag and the published flow "Welcome" (its keyword never matches, so only the ad starts it).
  expect((await page.request.post('/api/tags', { data: { name: tagName }, headers })).ok()).toBe(true);
  const flow = (await (await page.request.post('/api/flows', { data: { name: `Welcome ${suffix}` }, headers })).json()) as { id: string };
  const graph = { version: 1, start: 'a', triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`never${suffix}`], canInterrupt: false }], steps: [{ id: 'a', type: 'message', text: welcome, next: null }] };
  expect((await page.request.put(`/api/flows/${flow.id}/draft`, { data: { graph, draftRevision: 0 }, headers })).status()).toBe(200);
  expect((await page.request.post(`/api/flows/${flow.id}/publish`, { headers })).status()).toBe(200);

  // 1. An active chat ad; its page sets the flow and the tag.
  const campaignId = await launchChatAd(page, { name: `Ad chats ${suffix}`, numberId, mediaAssetId: imageId, primaryText: 'Spring sale on shoes' });
  await page.goto(`/ads/${campaignId}`);
  await expect(page.getByTestId('ad-status')).toHaveText('Active', { timeout: 60_000 });
  await page.getByLabel('Flow').selectOption({ label: `Welcome ${suffix}` });
  await page.getByLabel('Tag').selectOption({ label: tagName });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.getByText('Saved')).toBeVisible();
  const campaign = (await (await page.request.get(`/api/ads/campaigns/${campaignId}`)).json()) as { flowId: string; tagId: string; versions: Array<{ metaAdId: string }> };
  expect(campaign.flowId).toBe(flow.id);
  const adId = campaign.versions[0]!.metaAdId;

  // 2. A customer writes from the ad: the flow answers, live chat shows the ad and the free window, the contact is tagged.
  const customer = `+97155${suffix}3`;
  execSync(`npm run mock:inbound -- --from ${customer} --name "Ad Customer ${suffix}" --phone-number-id ${number.phoneNumberId} --text "Hi, I saw your ad" --referral-ad ${adId} --referral-headline "${headline}"`, {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: `Ad Customer ${suffix}` });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  await expect(page.getByTestId('ad-referral-card')).toContainText(headline);
  await expect(page.getByTestId('ad-referral-card')).toContainText(`Ad chats ${suffix}`);
  await expect(page.getByTestId('timeline').getByTestId('ad-referral')).toContainText(headline);
  await expect(page.getByTestId('timeline').getByTestId('chat-item').filter({ hasText: welcome })).toBeVisible({ timeout: 30_000 });
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('ad-referral-card')).toContainText('Free ad window until', { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  const contacts = (await (await page.request.get(`/api/contacts?q=${encodeURIComponent(customer)}`)).json()) as { items: Array<{ phone: string; tags: string[] }> };
  expect(contacts.items.find((c) => c.phone === customer)?.tags).toContain(tagName);
  const chats = (await (await page.request.get(`/api/ads/campaigns/${campaignId}/chats`)).json()) as { total: number };
  expect(chats.total).toBe(1);

  // 3. A message from an ad made outside the platform is listed under Other ads.
  const unknownAd = `77${suffix}01`;
  execSync(`npm run mock:inbound -- --from +97155${suffix}4 --name "Other ad ${suffix}" --phone-number-id ${number.phoneNumberId} --text "Hello" --referral-ad ${unknownAd}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await expect(async () => {
    await page.goto('/ads');
    await expect(page.getByTestId('other-ad-chats')).toContainText(unknownAd, { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
});
