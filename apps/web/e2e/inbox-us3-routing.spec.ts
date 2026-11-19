import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T047: quickstart US3 row (browser part) - an admin sets a "talk to a person" keyword; a customer
// sending it puts the chat under Waiting for agent and raises an alert. Transfer, auto-resolve,
// agent rules and filters across several members are covered by inbox-routing.int-spec.ts.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US3: a "talk to a person" keyword moves the chat to Waiting for agent and alerts the team', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `82${suffix}`;
  const customer = `+97156${suffix.slice(-6)}3`;
  const name = `Lina ${suffix.slice(-4)}`;
  const diag = collectDiagnostics(page);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const connect = await page.request.post('/api/numbers', {
    headers: await csrfHeaders(page),
    data: { label: `Routing ${suffix}`, wabaId: `MOCK_WABA_R3${suffix}`, phoneNumberId, accessToken: 'mock-token' },
  });
  expect(connect.status()).toBe(201);

  await page.goto('/settings/live-chat');
  await page.getByLabel('Keywords (comma separated)').fill('agent, talk to a person');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Live chat settings saved')).toBeVisible();

  execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --text "Hello" --phone-number-id ${phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --text "  Talk to a PERSON " --phone-number-id ${phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Waiting for agent/ }).click();
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await diag.check(() => expect(row).toBeVisible({ timeout: 15_000 }));
  await row.click();
  await expect(page.getByText('Waiting for agent', { exact: true })).toBeVisible();

  // The in-app alert reaches the admin.
  await page.getByRole('button', { name: /Notifications/ }).click();
  await expect(page.getByText('Waiting for an agent').first()).toBeVisible({ timeout: 30_000 });

  // Taking the chat clears the waiting state.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Take chat' }).click();
  await expect(page.getByText('Taken · you')).toBeVisible();
});
