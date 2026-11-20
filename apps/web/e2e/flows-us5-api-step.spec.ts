import { expect, test } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T056: quickstart US5 row - an API step with a secret header: the secret is shown masked after
// saving (also after reloading the editor), and a test request to a private address (10.0.0.5) is
// refused as a blocked address without being called.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';

test('US5: a secret header stays masked and a private address is blocked in the test request', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const secretValue = `sk-test-${suffix}`;
  const diag = collectDiagnostics(page);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow', exact: true }).click();
  await page.getByLabel('Flow name').fill(`Order lookup ${suffix}`);
  await page.getByRole('button', { name: 'Create flow', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}$/);

  // The secret is typed once and then only shown as ••••.
  await page.getByLabel('Secret name').fill('Shop token');
  await page.getByLabel('Secret value').fill(secretValue);
  await page.getByRole('button', { name: 'Save secret', exact: true }).click();
  const secrets = page.getByTestId('secrets');
  await diag.check(() => expect(secrets).toContainText('Shop token ••••', { timeout: 15_000 }));
  await expect(page.getByLabel('Secret value')).toHaveValue('');

  // An API step whose Authorization header uses the secret.
  await page.getByRole('button', { name: 'Add API call step', exact: true }).click();
  await page.getByLabel('Address').fill('https://10.0.0.5/orders');
  await page.getByRole('button', { name: 'Add header', exact: true }).click();
  await page.getByLabel('Header 1 value').fill('Bearer ');
  await page.getByLabel('Insert a secret into header 1').selectOption({ label: 'Shop token' });
  await expect(page.getByLabel('Header 1 value')).toHaveValue(/^Bearer \{secret:[0-9a-f-]{36}\}$/);
  await expect(page.getByText(/Secrets used: Shop token/)).toBeVisible();

  // The test request refuses the private address.
  await page.getByRole('button', { name: 'Send test request', exact: true }).click();
  await diag.check(() => expect(page.getByTestId('api-test-result')).toContainText('Blocked address', { timeout: 15_000 }));

  // After saving and reloading, the value is still never on the page.
  await expect(page.getByTestId('save-status')).toHaveText(/All changes saved|Not saved/, { timeout: 15_000 });
  await page.reload();
  await expect(page.getByTestId('secrets')).toContainText('Shop token ••••', { timeout: 15_000 });
  await expect(page.locator('body')).not.toContainText(secretValue);
});
