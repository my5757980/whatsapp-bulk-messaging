import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T039: quickstart US2 row - a chat older than 24 hours is under Past chats with free replies
// locked; a template restarts it and is delivered; the customer's answer makes it live again.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

const inbound = (args: string) => execSync(`npm run mock:inbound -- ${args}`, { cwd: REPO_ROOT, stdio: 'ignore' });

test('US2: a past chat is locked, a template restarts it, and the reply makes it live', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `81${suffix}`;
  const customer = `+97155${suffix.slice(-6)}2`;
  const name = `Omar ${suffix.slice(-4)}`;
  const diag = collectDiagnostics(page);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  const headers = await csrfHeaders(page);
  const connect = await page.request.post('/api/numbers', {
    headers,
    data: { label: `History ${suffix}`, wabaId: `MOCK_WABA_H${suffix}`, phoneNumberId, accessToken: 'mock-token' },
  });
  expect(connect.status()).toBe(201);
  expect((await page.request.post('/api/templates/sync', { headers })).ok()).toBe(true);

  // The customer last wrote 25 hours ago.
  inbound(`--from ${customer} --name "${name}" --at "-25h" --text "Do you deliver on Fridays?" --phone-number-id ${phoneNumberId}`);

  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Past chats/ }).click();
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  const locked = page.getByTestId('window-closed');
  await expect(locked).toContainText('24-hour reply window has closed');
  await expect(page.getByLabel('Reply')).toHaveCount(0);

  await locked.getByRole('button', { name: 'Send template' }).click();
  await page.getByLabel('Template', { exact: true }).selectOption({ label: 'order_confirmation (en_US, utility)' });
  await page.getByLabel('BODY.1').fill('Omar');
  await page.getByLabel('BODY.2').fill('#5521');
  await expect(page.getByLabel('Template preview')).toContainText('Hi Omar, your order #5521 is confirmed.');
  await page.getByRole('button', { name: 'Send', exact: true }).click();

  const sent = page.getByTestId('timeline').getByTestId('chat-item').filter({ hasText: 'Hi Omar, your order #5521 is confirmed.' });
  await expect(sent).toBeVisible({ timeout: 15_000 });
  await expect(sent.getByLabel(/Delivered|Read/)).toBeVisible({ timeout: 45_000 });

  // The customer answers: the window opens again and the reply box returns.
  inbound(`--from ${customer} --name "${name}" --text "Great, thanks!" --phone-number-id ${phoneNumberId}`);
  await diag.check(() => expect(page.getByTestId('timeline')).toContainText('Great, thanks!', { timeout: 15_000 }));
  await diag.check(() => expect(page.getByLabel('Reply')).toBeVisible({ timeout: 15_000 }));
});
