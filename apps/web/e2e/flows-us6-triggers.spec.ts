import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T063: quickstart US6 row - add a first-message rule with a tag in the trigger panel; a first
// message from a new number gets the flow's welcome and the contact gets the first-message tag.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US6: a first-message rule tags a new contact and starts its flow', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `90${suffix}`;
  const customer = { phone: `+97150${suffix.slice(-6)}7`, name: `Hiba ${suffix.slice(-4)}` };
  const word = `ad${suffix.slice(-5)}`;
  const welcome = `Thanks for answering our ad, ${suffix.slice(-4)}!`;
  const diag = collectDiagnostics(page);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  expect(
    (await page.request.post('/api/numbers', { headers, data: { label: `Flows US6 ${suffix}`, wabaId: `MOCK_WABA_F6${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);
  const tag = await page.request.post('/api/tags', { headers, data: { name: `from-ad-${suffix.slice(-5)}` } });
  expect(tag.status()).toBe(201);
  const tagId = ((await tag.json()) as { id: string }).id;

  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow', exact: true }).click();
  await page.getByLabel('Flow name').fill(`Ad welcome ${suffix}`);
  await page.getByRole('button', { name: 'Create flow', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}$/);

  await page.getByRole('button', { name: 'Add Message step', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill(welcome);
  await page.getByRole('button', { name: 'Add first-message rule', exact: true }).click();
  await page.getByLabel('First message words 1').fill(word);
  await page.getByLabel('First-message tag 1').selectOption(tagId);
  await expect(page.getByLabel('Also start this flow')).toBeChecked();
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByTestId('no-problems')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible({ timeout: 15_000 });

  // A first message from a new number.
  execSync(`npm run mock:inbound -- --from ${customer.phone} --name "${customer.name}" --phone-number-id ${phoneNumberId} --text "Hello, I saw your ${word}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await expect
    .poll(async () => {
      const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
      return sent.messages.some((m) => m.phoneNumberId === phoneNumberId && m.text === welcome);
    }, { timeout: 30_000 })
    .toBe(true);

  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: customer.name });
  await diag.check(() => expect(row).toBeVisible({ timeout: 15_000 }));
  await row.click();
  await expect(page.getByRole('complementary', { name: 'Contact' }).getByLabel('First-message tag')).toHaveValue(tagId, { timeout: 15_000 });
});
