import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T031: quickstart US2 row - build a question (saved to a contact attribute) and a list in the
// editor, answer from mock inbound (one wrong answer first), and check the answers in live chat:
// the final message uses them and the profile panel shows the saved attribute.
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

test('US2: a question saves the answer to the contact and a list choice is used later', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `87${suffix}`;
  const customer = `+97152${suffix.slice(-6)}2`;
  const name = `Layla ${suffix.slice(-4)}`;
  const keyword = `book${suffix.slice(-5)}`;
  const attribute = `guests_${suffix.slice(-5)}`;
  const branchQuestion = `Which branch, ${suffix.slice(-4)}?`;
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
    (await page.request.post('/api/numbers', { headers, data: { label: `Flows US2 ${suffix}`, wabaId: `MOCK_WABA_F2${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);
  expect((await page.request.post('/api/attributes', { headers, data: { key: attribute, label: 'Guests', type: 'NUMBER' } })).status()).toBe(201);

  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow', exact: true }).click();
  await page.getByLabel('Flow name').fill(`Book a table ${suffix}`);
  await page.getByRole('button', { name: 'Create flow', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}$/);

  // Built from the end, so every "goes to" target exists when it is chosen.
  await page.getByRole('button', { name: 'Add Message step', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Booked: {answer:guests} guests at {answer:branch}.');

  await page.getByRole('button', { name: 'Add List step', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill(branchQuestion);
  await page.getByLabel('List button label').fill('Branches');
  await page.getByLabel('Option 1', { exact: true }).fill('Marina');
  await page.getByRole('button', { name: 'Add option', exact: true }).click();
  await page.getByLabel('Option 2', { exact: true }).fill('Downtown');
  await page.getByLabel('Every option goes to the same step').check();
  await page.getByLabel('All options go to').selectOption('message-1');
  await page.getByLabel('Remember the choice as (optional)').fill('branch');

  await page.getByRole('button', { name: 'Add Question step', exact: true }).click();
  await page.getByLabel('Question', { exact: true }).fill('How many guests?');
  await page.getByLabel('Answer type').selectOption('number');
  await page.getByLabel('Smallest').fill('1');
  await page.getByLabel('Largest').fill('20');
  await page.getByLabel('Answer name').fill('guests');
  await page.getByLabel('Save to contact attribute (optional)').selectOption(attribute);
  await page.getByLabel('Message after a wrong answer').fill('Please send a number from 1 to 20.');
  await page.getByLabel('After a valid answer, go to').selectOption('list-1');
  await page.getByRole('button', { name: 'Make this the start', exact: true }).click();

  await page.getByRole('button', { name: 'Add keyword', exact: true }).click();
  await page.getByLabel('Keywords 1').fill(keyword);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByTestId('no-problems')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible({ timeout: 15_000 });

  // What the flow has sent to this customer so far (each answer waits for the message before it).
  const sentTo = async () =>
    ((await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: SentMessage[] }).messages.filter((m) => m.phoneNumberId === phoneNumberId);
  const waitForSent = (text: string) => expect.poll(async () => (await sentTo()).some((m) => m.text === text), { timeout: 30_000 }).toBe(true);

  // The customer answers: a wrong number first, then a valid one, then picks from the list.
  inbound(`--text "${keyword}"`);
  await waitForSent('How many guests?');
  inbound('--text "lots"');
  await waitForSent('Please send a number from 1 to 20.');
  inbound('--text "4"');
  await waitForSent(branchQuestion);
  const list = (await sentTo()).find((m) => m.type === 'interactive' && m.text === branchQuestion);
  const tapId = list?.options?.find((o) => o.title === 'Downtown')?.id ?? '';
  expect(tapId).not.toBe('');
  inbound(`--list-reply Downtown --list-id "${tapId}"`);

  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  const timeline = page.getByTestId('timeline');
  await diag.check(() => expect(timeline.getByTestId('chat-item').filter({ hasText: 'Please send a number from 1 to 20.' })).toHaveCount(1, { timeout: 20_000 }));
  await diag.check(() => expect(timeline.getByTestId('chat-item').filter({ hasText: 'Booked: 4 guests at Downtown.' })).toHaveCount(1, { timeout: 20_000 }));
  await expect(page.getByRole('complementary', { name: 'Contact' })).toContainText(`${attribute}: 4`, { timeout: 15_000 });
});
