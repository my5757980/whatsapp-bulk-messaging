import { expect, test } from '@playwright/test';
import { ensureAdsConnected, uploadAdImage } from './ads-helpers';
import { PHONE_UA, PREVIEW_UA, signInAsAdmin } from './growth-helpers';

// T063 (feature 007, quickstart US8 row): on mock-meta, Write with AI fills the texts of a website ad
// (mock-meta's fake model); after submitting, its counted link counts one visit for a preview and a real open.
test('US8: AI drafts the texts of a website ad, and its counted link counts real visits only', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = String(Date.now()).slice(-6);
  const imageName = `ad-us8-${suffix}.jpg`;
  await signInAsAdmin(page);
  await ensureAdsConnected(page);
  await uploadAdImage(page, imageName);

  await page.goto('/ads/new');
  await page.getByLabel('Campaign name').fill(`Spring web ${suffix}`);
  await page.getByRole('radio', { name: 'Visits to a web page' }).check();
  await page.getByLabel('Web page (https)').fill('https://shop.example.com/spring');
  await page.getByLabel('Places').fill('United');
  await page.getByRole('button', { name: 'Add United Arab Emirates' }).click();
  await page.getByLabel('Daily budget (AED)').fill('50');
  await page.getByLabel('Image or video').selectOption({ label: `${imageName} (image)` });

  // Write with AI fills the main text and headline.
  await page.getByRole('button', { name: 'Write with AI' }).click();
  await page.getByLabel('What do you offer?').fill('Spring shoes with free delivery in Dubai');
  await page.getByRole('button', { name: 'Draft texts' }).click();
  await expect(page.getByTestId('ai-option')).toHaveCount(3);
  await page.getByRole('button', { name: 'Use option 1' }).click();
  await expect(page.getByLabel('Main text')).toHaveValue(/Spring shoes with free delivery in Dubai/);
  await expect(page.getByLabel('Headline')).not.toHaveValue('');

  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/ads\/[0-9a-f-]{36}$/);
  const link = (await page.getByTestId('ad-link-url').textContent())!.trim();
  expect(link).toMatch(/\/l\/a\/[0-9A-Za-z]{10}$/);

  // A link preview is not a visit; a real open is, and goes on with the utm values.
  const preview = await page.request.get(link, { headers: { 'user-agent': PREVIEW_UA }, maxRedirects: 0 });
  expect(preview.status()).toBe(302);
  const open = await page.request.get(link, { headers: { 'user-agent': PHONE_UA }, maxRedirects: 0 });
  expect(open.status()).toBe(302);
  expect(open.headers().location).toContain('utm_source=meta&utm_medium=paid');
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('ad-result-visits')).toHaveText('1', { timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
});
