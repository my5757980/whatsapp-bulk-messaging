import { expect, test } from '@playwright/test';
import { signInAsAdmin } from './growth-helpers';

// T081 (feature 006, quickstart US8 row): the wizard on mock-meta (tools/mock-meta/src/wizard.ts). A
// token missing a permission is named with its fix; the good token reaches the mock account, the
// number is registered with its PIN and the app subscribed, the test message is delivered, and the
// number is saved. The health check on the saved number then passes.
test('US8: the number wizard names a missing permission, then connects a number after its fixes and the test message', async ({ page }) => {
  test.setTimeout(180_000);
  await signInAsAdmin(page);
  await page.goto('/settings/numbers');
  await page.getByRole('link', { name: 'Connect with checks' }).click();
  await expect(page).toHaveURL(/\/numbers\/connect$/);

  // 1. A token without the messaging permission is named, with its fix.
  await page.getByLabel('Access token').fill('mock-token-missing-scope-wizard');
  await page.getByRole('button', { name: 'Check token' }).click();
  await expect(page.getByTestId('wizard-token')).toContainText('missing the permission whatsapp_business_messaging');
  await expect(page.getByTestId('wizard-token')).toContainText('System users');

  // 2. The good token lists the mock account and its number.
  await page.getByLabel('Access token').fill('mock-token-ok-wizard');
  await page.getByRole('button', { name: 'Check token' }).click();
  await expect(page.getByTestId('wizard-token')).toContainText('Meta accepts the token.');
  await page.getByRole('radio', { name: /\+1 555 019 9001/ }).check();
  await page.getByRole('button', { name: 'Run checks' }).click();
  await expect(page.getByTestId('wizard-check-NUMBER_REGISTERED')).toContainText('Failed');
  await expect(page.getByTestId('wizard-check-APP_SUBSCRIBED')).toContainText('Failed');

  // 3. The fixes, each after the admin asks: register with the PIN, then subscribe the app.
  await page.getByLabel('Two-step PIN').fill('123456');
  await page.getByRole('button', { name: 'Register the number' }).click();
  await expect(page.getByTestId('wizard-check-NUMBER_REGISTERED')).toContainText('Passed');
  await page.getByRole('button', { name: 'Subscribe the app' }).click();
  await expect(page.getByTestId('wizard-check-APP_SUBSCRIBED')).toContainText('Passed');
  await expect(page.getByTestId('wizard-ready')).toHaveText('Ready: nothing failed.');

  // 4. The test message, with its delivered status webhook.
  await page.getByLabel('Your WhatsApp number').fill('+971501234567');
  await page.getByRole('button', { name: 'Send test message' }).click();
  await expect(page.getByTestId('wizard-test-result')).toHaveText('Delivered: the status arrived.', { timeout: 70_000 });

  // 5. Save, then the health check on the saved number.
  await page.getByLabel('I got the message on my phone').check();
  await page.getByLabel('Name in the dashboard').fill('Wizard number');
  await page.getByRole('button', { name: 'Save number' }).click();
  await expect(page).toHaveURL(/\/settings\/numbers$/);
  await expect(page.getByText('Wizard number', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Run checks on Wizard number' }).click();
  await expect(page.getByRole('dialog').getByTestId('wizard-check-NUMBER_REGISTERED')).toContainText('Passed', { timeout: 15_000 });
});
