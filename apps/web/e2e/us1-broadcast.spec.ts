import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// T083: quickstart US1 row against the full local stack with tools/mock-meta.
// Requires a seeded admin (see quickstart.md); override with E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const CSV = fileURLToPath(new URL('../../../samples/contacts-10.csv', import.meta.url));

test('US1: connect, sync, upload, map, send and see 9 delivered/read + 1 failed', async ({ page }) => {
  const suffix = Date.now().toString().slice(-6);
  const label = `Mock line ${suffix}`;

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  // Connect the mock number (mock-meta accepts the token "mock-token").
  await page.goto('/settings/numbers');
  await page.getByRole('button', { name: 'Connect number' }).click();
  await page.getByLabel('Label').fill(label);
  await page.getByLabel('WhatsApp Business Account ID').fill(`MOCK_WABA_${suffix}`);
  await page.getByLabel('Phone number ID').fill(`10${suffix}`);
  await page.getByLabel('Access token').fill('mock-token');
  await page.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(page.getByRole('cell', { name: new RegExp(`^${label}`) })).toBeVisible();

  // Sync templates from mock-meta.
  await page.goto('/templates');
  await page.getByRole('button', { name: /Sync from Meta/ }).click();
  // The sync reads every connected account one by one; wait for it to finish, not for an older account's row.
  await expect(page.getByText(/Templates synced/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('order_confirmation').first()).toBeVisible();

  // Wizard step 1: basics.
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(`E2E broadcast ${suffix}`);
  await page.getByLabel('Send from').selectOption({ label: `${label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: 'order_confirmation · en_US · Utility' });
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Step 2: audience upload with opt-in confirmation.
  await page.getByLabel(/Recipient list/).setInputFiles(CSV);
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E sample list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText('10 rows processed', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  // Step 3: BODY.1 -> name column, BODY.2 -> static text.
  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
  const body2 = page.getByTestId('mapping-BODY.2');
  await body2.getByLabel('Source').selectOption('static');
  await body2.getByLabel('Text').fill('#E2E');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Step 4: review and send.
  await expect(page.getByTestId('eligible-count')).toHaveText('10');
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);

  // Live statuses: every row ends delivered/read or failed with a reason.
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });
  await expect(async () => {
    await page.reload();
    const delivered = Number(await page.getByTestId('total-delivered').textContent());
    const read = Number(await page.getByTestId('total-read').textContent());
    expect(delivered + read).toBe(9);
    await expect(page.getByTestId('total-failed')).toHaveText('1');
  }).toPass({ timeout: 60_000 });

  await page.getByLabel('Filter by status').selectOption('FAILED');
  await expect(page.getByTestId('recipient-row')).toHaveCount(1);
  await expect(page.getByTestId('recipient-row')).toContainText(/undeliverable/i);
});
