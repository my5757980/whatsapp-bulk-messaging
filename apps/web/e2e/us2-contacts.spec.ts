import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// T119: quickstart US2 row - import samples/contacts-100.csv, check the error report, send STOP
// through mock-meta and confirm the audience count excludes the contact.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CSV = fileURLToPath(new URL('../../../samples/contacts-100.csv', import.meta.url));
const STOP_PHONE = '+971500000001';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US2: import contacts, honour STOP and exclude the contact from audiences', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  // Attribute definitions used by the sample file (409 when they already exist is fine).
  const headers = await csrfHeaders(page);
  for (const data of [
    { key: 'city', label: 'City', type: 'TEXT' },
    { key: 'last_order_date', label: 'Last order date', type: 'DATE' },
  ]) {
    const res = await page.request.post('/api/attributes', { data, headers });
    expect([201, 409]).toContain(res.status());
  }

  await page.goto('/contacts/import');
  await page.getByLabel(/Contacts file/).setInputFiles(CSV);
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel('Name column').selectOption('name');
  await page.getByLabel('Tags column').selectOption('tags');
  await page.getByLabel('Attribute city').selectOption('city');
  await page.getByLabel('Attribute last_order_date').selectOption('last_order_date');
  await page.getByLabel(/every contact in this file opted in/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E sample import');
  await page.getByRole('button', { name: 'Start import' }).click();

  const summary = page.getByTestId('import-summary');
  await expect(summary).toContainText('103 rows processed', { timeout: 60_000 });
  await expect(summary).toContainText('3 invalid');
  await expect(page.getByRole('link', { name: 'Download error report' })).toBeVisible();

  // The customer replies STOP (mock-meta posts a signed inbound webhook).
  execSync(`npm run mock:inbound -- --from ${STOP_PHONE} --text STOP`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await expect(async () => {
    await page.goto(`/contacts?q=${STOP_PHONE.slice(-9)}`);
    await expect(page.getByTestId('contact-row').first()).toContainText('Opted out', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });

  const preview = await page.request.post('/api/contacts/audience-preview', {
    data: { filter: { all: [{ tag: 'newsletter' }] }, templateCategory: 'UTILITY' },
    headers: await csrfHeaders(page),
  });
  expect(preview.ok()).toBe(true);
  const counts = (await preview.json()) as { eligible: number; excluded: { optedOut: number } };
  expect(counts.excluded.optedOut).toBeGreaterThanOrEqual(1);
});
