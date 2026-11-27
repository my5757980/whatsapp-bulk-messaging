import { expect, test } from '@playwright/test';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';
import { STRIPE_KEY_OK, STRIPE_KEY_REJECTED } from './payments-helpers';

// T025 (feature 008, quickstart US1 row): connecting the mock Stripe account. A rejected key is
// refused; the good key with automatic registration passes every check and shows Test mode and AED;
// Test notifications turns to "Notifications working"; the key is never shown again.
test('US1: connects Stripe with checks and proves notifications arrive', async ({ page }) => {
  test.setTimeout(120_000);
  await signInAsAdmin(page);
  // Start from no connection (other payments tests may have saved one).
  await page.request.delete('/api/payments/gateway', { headers: await csrfHeaders(page) });

  await page.goto('/payments/gateway');
  await expect(page.getByRole('heading', { name: 'Stripe connection' })).toBeVisible();

  // 1. A key Stripe rejects is refused and nothing is saved.
  await page.getByLabel('Stripe key').fill(STRIPE_KEY_REJECTED);
  await page.getByRole('button', { name: 'Save and check' }).click();
  // Next's route announcer is also role="alert"; ours is the paragraph with the message.
  await expect(page.getByRole('alert').filter({ hasText: 'Stripe does not accept this key' })).toBeVisible();

  // 2. The good key, with the address registered for us: every check passes.
  await page.getByLabel('Stripe key').fill(STRIPE_KEY_OK);
  await page.getByLabel('Register the notification address for me').check();
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(page.getByTestId('gateway-mode')).toHaveText('Test mode');
  await expect(page.getByTestId('gateway-currency')).toHaveText('AED');
  for (const check of ['KEY_FORMAT', 'ACCOUNT_READ', 'CHARGES_ENABLED', 'CHECKOUT_ACCESS', 'WEBHOOK_ENDPOINT']) {
    await expect(page.getByTestId(`gateway-check-${check}`)).toContainText('Passed');
  }

  // 3. Notifications reach the platform.
  await page.getByRole('button', { name: 'Test notifications' }).click();
  await expect(page.getByTestId('notification-check')).toContainText('Notifications working', { timeout: 60_000 });

  // 4. The key is never shown again; only replacing and disconnecting are offered.
  await page.reload();
  await expect(page.getByText(STRIPE_KEY_OK)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Replace keys' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Disconnect' })).toBeVisible();
});
