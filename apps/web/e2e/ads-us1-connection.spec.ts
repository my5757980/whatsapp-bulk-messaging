import { expect, test } from '@playwright/test';
import { ADS_TOKEN_NO_LEADS, ADS_TOKEN_OK } from './ads-helpers';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';

// T021 (feature 007, quickstart US1 row): connecting the ad account on mock-meta. A token without
// leads_retrieval is named with what stops working; the good token lists act_MOCKADS and MOCKPAGE; the
// saved connection shows AED and Asia/Dubai, and its checks run again.
test('US1: connects the ad account and page with checks', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsAdmin(page);
  // Start from no connection (other ads tests may have saved one).
  await page.request.delete('/api/ads/connection', { headers: await csrfHeaders(page) });

  await page.goto('/ads/connect');
  await expect(page.getByRole('heading', { name: 'Ad account connection' })).toBeVisible();

  // 1. A token without leads_retrieval is named, with what stops working.
  await page.getByLabel('Access token').fill(ADS_TOKEN_NO_LEADS);
  await page.getByRole('button', { name: 'Check token' }).click();
  await expect(page.getByTestId('ads-token')).toContainText('missing leads_retrieval (for receiving leads)');

  // 2. The good token lists the mock ad account and page; the checks pass.
  await page.getByLabel('Access token').fill(ADS_TOKEN_OK);
  await page.getByRole('button', { name: 'Check token' }).click();
  await expect(page.getByTestId('ads-token')).toContainText('Meta accepts the token.');
  await page.getByRole('radio', { name: /act_MOCKADS/ }).check();
  await page.getByRole('radio', { name: /Mock Page/ }).check();
  await page.getByRole('button', { name: 'Run checks' }).click();
  await expect(page.getByTestId('ads-check-AD_ACCOUNT_ACTIVE')).toContainText('Passed');
  await expect(page.getByTestId('ads-check-PAGE_WHATSAPP_NUMBERS')).toContainText('Passed');

  // 3. Save: the connection card shows the currency and time zone, and the checks run again.
  await page.getByRole('button', { name: 'Save connection' }).click();
  const card = page.getByTestId('ads-connection-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('ads-currency')).toHaveText('AED');
  await expect(page.getByTestId('ads-timezone')).toHaveText('Asia/Dubai');
  await card.getByRole('button', { name: 'Run checks' }).click();
  await expect(page.getByText('All checks passed')).toBeVisible();
});
