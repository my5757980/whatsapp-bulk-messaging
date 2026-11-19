import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T078: quickstart US6 row - with working hours that exclude now and an off-hours text, a customer
// gets exactly one automatic reply, shown as automatic in the chat.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLOSED = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, []]));

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US6: one off-hours reply outside working hours', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `85${suffix}`;
  const customer = `+97158${suffix.slice(-6)}6`;
  const name = `Hala ${suffix.slice(-4)}`;
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
    (await page.request.post('/api/numbers', { headers, data: { label: `Hours ${suffix}`, wabaId: `MOCK_WABA_H6${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);

  const original = await (await page.request.get('/api/live-chat/settings')).json();
  const put = (body: unknown) => page.request.put('/api/live-chat/settings', { headers, data: body });
  expect((await put({ ...original, workingHours: CLOSED, offHoursEnabled: true, offHoursContent: { kind: 'TEXT', text: 'We are closed right now; we will reply in the morning.' } })).status()).toBe(200);

  try {
    inbound('Hello?');
    inbound('Anyone there?');
    await page.goto('/inbox');
    const row = page.getByTestId('conversation-row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    const automatic = page.getByTestId('timeline').getByTestId('chat-item').filter({ hasText: 'We are closed right now' });
    await diag.check(() => expect(automatic).toHaveCount(1, { timeout: 15_000 }));
    await expect(automatic).toContainText('Automatic');
    // Sent through mock-meta, so the ticks arrive like any reply.
    await expect(automatic.getByLabel(/Sent|Delivered|Read/)).toBeVisible({ timeout: 45_000 });
  } finally {
    await put({ ...original, offHoursEnabled: false, offHoursContent: null });
  }
});
