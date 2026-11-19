import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T069: quickstart US5 row - the chat profile shows the source and counts, edits land in the
// journey, and blocking hides the chat from live lists until it is unblocked.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US5: profile, journey and blocking', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `84${suffix}`;
  const customer = `+97154${suffix.slice(-6)}5`;
  const name = `Noor ${suffix.slice(-4)}`;
  const tagName = `vip${suffix.slice(-5)}`;
  const diag = collectDiagnostics(page);
  const inbound = (text: string) =>
    execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --text "${text}" --phone-number-id ${phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  expect(
    (await page.request.post('/api/numbers', { headers, data: { label: `Profile ${suffix}`, wabaId: `MOCK_WABA_P${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);
  expect((await page.request.post('/api/tags', { headers, data: { name: tagName } })).status()).toBe(201);

  inbound('Hello there');
  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  const profile = page.getByRole('complementary', { name: 'Contact' });
  await expect(profile).toContainText('Organic');
  await expect(profile).toContainText('0 template · 0 replies');

  await profile.getByLabel('Add a tag').selectOption({ label: tagName });
  await diag.check(() => expect(profile.getByTestId('journey')).toContainText(`Tag "${tagName}" added`, { timeout: 15_000 }));

  await profile.getByRole('button', { name: 'Block contact' }).click();
  await page.getByRole('button', { name: 'Block', exact: true }).click();
  await expect(profile.getByText('Blocked', { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(profile.getByTestId('journey')).toContainText('Blocked by');

  // A blocked contact's new message is kept quietly; the chat is not in the live list.
  inbound('Are you there?');
  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Open/ }).click();
  await expect(page.getByTestId('conversation-row').filter({ hasText: name })).toHaveCount(0);

  await page.getByRole('tab', { name: /Past chats/ }).click();
  await page.getByTestId('conversation-row').filter({ hasText: name }).click();
  await page.getByRole('complementary', { name: 'Contact' }).getByRole('button', { name: 'Unblock contact' }).click();
  await page.getByRole('tab', { name: /Open/ }).click();
  await diag.check(() => expect(page.getByTestId('conversation-row').filter({ hasText: name })).toBeVisible({ timeout: 15_000 }));
});
