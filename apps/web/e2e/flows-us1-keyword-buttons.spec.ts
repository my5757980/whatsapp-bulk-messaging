import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T020: quickstart US1 row - build a flow in the editor (a buttons step whose two buttons lead to
// two messages, plus a keyword), publish it, then a customer sends the keyword, taps a button and
// gets that button's answer; both automatic messages show in the live chat timeline.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';

interface SentMessage {
  phoneNumberId: string;
  type: string;
  text?: string;
  options?: Array<{ id: string; title: string }>;
}

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US1: a keyword starts a published flow and a button tap continues it', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `86${suffix}`;
  const customer = `+97159${suffix.slice(-6)}1`;
  const name = `Omar ${suffix.slice(-4)}`;
  const keyword = `hours${suffix.slice(-5)}`;
  const question = `Which branch, ${suffix.slice(-4)}?`;
  const diag = collectDiagnostics(page);
  const inbound = (args: string) =>
    execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --phone-number-id ${phoneNumberId} ${args}`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  expect(
    (await page.request.post('/api/numbers', { headers, data: { label: `Flows ${suffix}`, wabaId: `MOCK_WABA_F1${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);

  // Create the flow from the list.
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow' }).click();
  await page.getByLabel('Flow name').fill(`Opening hours ${suffix}`);
  await page.getByRole('button', { name: 'Create flow' }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}$/);

  // The two answers first, then the buttons step that leads to them (made the start step).
  await page.getByRole('button', { name: 'Add Message step' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Dubai branch: open 9am to 6pm');
  await page.getByRole('button', { name: 'Add Message step' }).click();
  await page.getByLabel('Message', { exact: true }).fill('Sharjah branch: open 10am to 8pm');
  await page.getByRole('button', { name: 'Add Buttons step' }).click();
  await page.getByLabel('Message', { exact: true }).fill(question);
  await page.getByLabel('Button 1', { exact: true }).fill('Dubai');
  await page.getByRole('button', { name: 'Add button' }).click();
  await page.getByLabel('Button 2', { exact: true }).fill('Sharjah');
  await page.getByLabel('Button 1 goes to').selectOption('message-1');
  await page.getByLabel('Button 2 goes to').selectOption('message-2');
  await page.getByRole('button', { name: 'Make this the start' }).click();
  await expect(page.getByTestId('flow-step').filter({ hasText: question })).toContainText('Start');

  await page.getByRole('button', { name: 'Add keyword' }).click();
  await page.getByLabel('Keywords 1').fill(keyword);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByTestId('no-problems')).toBeVisible();

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible({ timeout: 15_000 });

  // The customer sends the keyword: the flow answers with the buttons.
  inbound(`--text "${keyword}"`);
  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const timeline = page.getByTestId('timeline');
  const buttons = timeline.getByTestId('chat-item').filter({ hasText: question });
  await diag.check(() => expect(buttons).toHaveCount(1, { timeout: 20_000 }));
  await expect(buttons).toContainText('Automatic');

  // Tap "Sharjah" with the reply id WhatsApp would send back.
  let tapId = '';
  await expect
    .poll(
      async () => {
        const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: SentMessage[] };
        const message = sent.messages.find((m) => m.phoneNumberId === phoneNumberId && m.type === 'interactive' && m.text === question);
        tapId = message?.options?.find((o) => o.title === 'Sharjah')?.id ?? '';
        return tapId;
      },
      { timeout: 30_000 },
    )
    .not.toBe('');
  inbound(`--button-reply Sharjah --button-id "${tapId}"`);

  const answer = timeline.getByTestId('chat-item').filter({ hasText: 'Sharjah branch: open 10am to 8pm' });
  await diag.check(() => expect(answer).toHaveCount(1, { timeout: 20_000 }));
  await expect(answer).toContainText('Automatic');
  await expect(timeline.getByTestId('chat-item').filter({ hasText: 'Dubai branch' })).toHaveCount(0);
});
