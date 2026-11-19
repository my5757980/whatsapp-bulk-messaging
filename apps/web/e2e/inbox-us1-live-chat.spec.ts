import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// T026: quickstart US1 row - a customer's message appears in Open within seconds; a member takes
// the chat, replies, sees the ticks and closes it (specs/002-team-inbox/quickstart.md).
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US1: receive a customer message live, take the chat, reply with ticks and close it', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `80${suffix}`;
  // Avoid mock-meta's failure endings (0000 and 0047).
  const customer = `+97150${suffix.slice(-6)}1`;
  const name = `Sara ${suffix.slice(-4)}`;

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  const connect = await page.request.post('/api/numbers', {
    headers: await csrfHeaders(page),
    data: { label: `Live chat ${suffix}`, wabaId: `MOCK_WABA_C${suffix}`, phoneNumberId, accessToken: 'mock-token' },
  });
  expect(connect.status()).toBe(201);

  // Open live chat first, so the message has to arrive through the live stream.
  await page.getByRole('link', { name: /Live chat/ }).click();
  await expect(page).toHaveURL(/\/inbox/);
  await expect(page.getByRole('tab', { name: /Open/ })).toBeVisible();

  execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --text "Is the blue one available?" --phone-number-id ${phoneNumberId}`, {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });

  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toContainText('Is the blue one available?');
  await row.click();

  const timeline = page.getByTestId('timeline');
  await expect(timeline).toContainText('Is the blue one available?');
  await page.getByRole('button', { name: 'Take chat' }).click();
  await expect(page.getByText('Taken · you')).toBeVisible();

  await page.getByLabel('Reply').fill('Yes, it is in stock!');
  await page.getByLabel('Reply').press('Enter');
  const reply = timeline.getByTestId('chat-item').filter({ hasText: 'Yes, it is in stock!' });
  await expect(reply).toBeVisible();
  await expect(page.getByLabel('Reply')).toHaveValue('');
  // mock-meta reports sent, delivered and read within about two seconds of the send.
  await expect(reply.getByLabel('Read')).toBeVisible({ timeout: 45_000 });

  const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; type: string; text?: string }> };
  expect(sent.messages.some((m) => m.phoneNumberId === phoneNumberId && m.type === 'text' && m.text === 'Yes, it is in stock!')).toBe(true);

  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByRole('button', { name: 'Take chat' })).toBeVisible();
});
