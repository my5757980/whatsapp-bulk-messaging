import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T060: quickstart US4 row - "/" inserts a saved reply with its variables and a parameter; a PDF
// is sent from the computer through the media library; a 20 MB video is refused before sending.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PDF = fileURLToPath(new URL('../../../samples/media/brochure.pdf', import.meta.url));

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US4: send a saved reply and a file, and refuse a video over the limit', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `83${suffix}`;
  const customer = `+97152${suffix.slice(-6)}4`;
  const replyName = `open hours ${suffix.slice(-4)}`;
  const diag = collectDiagnostics(page);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  const headers = await csrfHeaders(page);
  expect(
    (await page.request.post('/api/numbers', { headers, data: { label: `Replies ${suffix}`, wabaId: `MOCK_WABA_S${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);
  expect((await page.request.post('/api/canned-messages', { headers, data: { name: replyName, type: 'TEXT', text: 'Hi {first_name}, we open at {{1}}' } })).status()).toBe(201);

  execSync(`npm run mock:inbound -- --from ${customer} --name "Sara ${suffix.slice(-4)}" --text "When do you open?" --phone-number-id ${phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: `Sara ${suffix.slice(-4)}` });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();

  // "/" opens the saved replies; the parameter is asked for before sending.
  await page.getByLabel('Reply').fill(`/${replyName}`);
  await page.getByRole('option', { name: new RegExp(replyName) }).click();
  await page.getByLabel('Parameter 1').fill('9');
  await page.getByLabel('Saved reply parameters').getByRole('button', { name: 'Send' }).click();
  const timeline = page.getByTestId('timeline');
  await diag.check(() => expect(timeline.getByTestId('chat-item').filter({ hasText: 'Hi Sara, we open at 9' })).toBeVisible({ timeout: 15_000 }));

  // A 20 MB video is refused in the browser, before any upload.
  await page.getByRole('button', { name: 'Attach' }).click();
  await page.getByLabel('From your computer').setInputFiles({ name: 'clip.mp4', mimeType: 'video/mp4', buffer: Buffer.alloc(20 * 1024 * 1024) });
  await expect(page.getByText('Videos can be at most 16 MB')).toBeVisible();

  // A PDF goes through the media library and arrives in the chat.
  await page.getByLabel('From your computer').setInputFiles(PDF);
  await page.getByLabel('Caption (optional)').fill('Our brochure');
  await page.getByRole('button', { name: /^Send "/ }).click();
  await diag.check(() => expect(timeline.getByTestId('chat-item').filter({ hasText: 'Our brochure' })).toBeVisible({ timeout: 15_000 }));
  await expect(timeline.getByRole('link', { name: /brochure\.pdf/ })).toBeVisible();
});
