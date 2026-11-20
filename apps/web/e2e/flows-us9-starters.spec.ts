import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// T079: quickstart US9 row - create a flow from the "Lead capture" starter, accept the offer to create
// its missing attributes, give it our own keyword, publish it and run it from a phone.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US9: a flow made from the Lead capture starter can be published and run', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `93${suffix}`;
  const keyword = `lead${suffix.slice(-5)}`;

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  expect(
    (await page.request.post('/api/numbers', { headers: await csrfHeaders(page), data: { label: `Flows US9 ${suffix}`, wabaId: `MOCK_WABA_F9${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);

  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow', exact: true }).click();
  await page.getByLabel('Flow name').fill(`Leads ${suffix}`);
  await page.getByLabel('Start from').selectOption('lead_capture');
  await expect(page.getByText(/Asks for a name, an email/)).toBeVisible();
  await page.getByRole('button', { name: 'Create flow', exact: true }).click();

  // Attributes other specs created may already exist; the offer only lists the missing ones.
  const offer = page.getByRole('button', { name: 'Create attributes and open', exact: true });
  await expect(offer.or(page.getByTestId('save-status'))).toBeVisible({ timeout: 15_000 });
  if (await offer.isVisible()) await offer.click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('flow-step').filter({ hasText: 'What is your name?' })).toBeVisible();

  // Our own keyword (other specs' customers might write "quote"), then publish.
  await page.getByLabel('Keywords 1').fill(keyword);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByTestId('no-problems')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible({ timeout: 15_000 });

  execSync(`npm run mock:inbound -- --from +97150${suffix.slice(-6)}3 --name "Lead ${suffix.slice(-4)}" --phone-number-id ${phoneNumberId} --text "Hi, ${keyword} here"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await expect
    .poll(async () => {
      const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
      return sent.messages.some((m) => m.phoneNumberId === phoneNumberId && m.text === 'Thanks for getting in touch! What is your name?');
    }, { timeout: 30_000 })
    .toBe(true);
});
