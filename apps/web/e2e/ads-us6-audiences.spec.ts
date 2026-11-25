import { expect, test } from '@playwright/test';
import { ensureAdsConnected } from './ads-helpers';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';

// T052 (feature 007, quickstart US6 row): on mock-meta, an audience made from a tag of 105
// contacts is sent and shows its size, a lookalike is made from it, and the builder offers it.
test('US6: makes an audience from a tag, a lookalike, and offers it in the builder', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = String(Date.now()).slice(-6);
  const tagName = `vip-${suffix}`;
  const audienceName = `VIP ${suffix}`;
  await signInAsAdmin(page);
  await ensureAdsConnected(page);
  const headers = await csrfHeaders(page);
  expect((await page.request.post('/api/tags', { data: { name: tagName }, headers })).ok()).toBe(true);
  for (let start = 0; start < 105; start += 15) {
    await Promise.all(
      Array.from({ length: Math.min(15, 105 - start) }, async (_, i) => {
        const phone = `+97150${suffix.slice(-4)}${String(start + i).padStart(3, '0')}`;
        const res = await page.request.post('/api/contacts', { headers, data: { phone, name: `Vip ${start + i}`, tags: [tagName] } });
        expect([201, 409]).toContain(res.status());
      }),
    );
  }

  // 1. The audience from the tag is sent to Meta and shows its size.
  await page.goto('/ads/audiences');
  await page.getByLabel('Name', { exact: true }).fill(audienceName);
  await page.getByLabel('Tag', { exact: true }).selectOption({ label: `${tagName} (105)` });
  await page.getByRole('button', { name: 'Make audience' }).click();
  const row = page.getByTestId('audience-row').filter({ hasText: audienceName }).first();
  await expect(row.getByTestId('audience-status')).toHaveText('Ready', { timeout: 60_000 });
  await expect(row.getByTestId('audience-size')).toHaveText('105');

  // 2. A lookalike in the UAE, the closest 1%.
  await row.getByRole('button', { name: 'Lookalike…' }).click();
  await row.getByRole('button', { name: 'Make lookalike' }).click();
  await expect(page.getByTestId('audience-row').filter({ hasText: 'Lookalike · AE · 1%' }).filter({ hasText: audienceName })).toBeVisible();

  // 3. The builder offers the ready audience.
  await page.goto('/ads/new');
  await expect(page.getByTestId('ad-audiences')).toContainText(audienceName);
  await page.getByRole('checkbox', { name: `Show to ${audienceName}`, exact: true }).check();
  await expect(page.getByRole('checkbox', { name: `Show to ${audienceName}`, exact: true })).toBeChecked();
});
