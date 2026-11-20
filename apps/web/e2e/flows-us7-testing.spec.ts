import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// T069: quickstart US7 row - add a test number, change the draft after publishing, and compare what
// the test number (the draft) and another number (the published version) receive.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US7: a test number gets the draft while other numbers get the published flow', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `91${suffix}`;
  const tester = `+97154${suffix.slice(-6)}8`;
  const customer = `+97155${suffix.slice(-6)}9`;
  const keyword = `try${suffix.slice(-5)}`;
  const published = `Published hello ${suffix.slice(-4)}`;
  const draft = `Draft hello ${suffix.slice(-4)}`;
  const send = (from: string) => execSync(`npm run mock:inbound -- --from ${from} --name "Tester ${from.slice(-4)}" --phone-number-id ${phoneNumberId} --text "${keyword}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const textsSentTo = async (phone: string) => {
    const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; to: string; text?: string }> };
    return sent.messages.filter((m) => m.phoneNumberId === phoneNumberId && m.to === phone.slice(1)).map((m) => m.text);
  };

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  expect(
    (await page.request.post('/api/numbers', { headers: await csrfHeaders(page), data: { label: `Flows US7 ${suffix}`, wabaId: `MOCK_WABA_F7${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);

  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow', exact: true }).click();
  await page.getByLabel('Flow name').fill(`Try before publishing ${suffix}`);
  await page.getByRole('button', { name: 'Create flow', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}$/);

  // Version 1 says the published text.
  await page.getByRole('button', { name: 'Add Message step', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill(published);
  await page.getByRole('button', { name: 'Add keyword', exact: true }).click();
  await page.getByLabel('Keywords 1').fill(keyword);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible({ timeout: 15_000 });

  // A test number, then a draft change that is not published.
  await page.getByLabel('Test number 1').fill(tester);
  await page.getByRole('button', { name: 'Save test numbers', exact: true }).click();
  await expect(page.getByText('Test numbers saved')).toBeVisible({ timeout: 15_000 });
  await page.getByLabel('Message', { exact: true }).fill(draft);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByText('Changes not published yet')).toBeVisible();

  send(tester);
  send(customer);
  await expect.poll(() => textsSentTo(tester), { timeout: 30_000 }).toContain(draft);
  await expect.poll(() => textsSentTo(customer), { timeout: 30_000 }).toContain(published);
  expect(await textsSentTo(tester)).not.toContain(published);
  expect(await textsSentTo(customer)).not.toContain(draft);
});
