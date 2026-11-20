import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T048: quickstart US4 row - build a condition with two rules (any may match) and a tag step in the
// editor; one customer goes down the Yes branch, another down the No branch, and the tag lands on
// the contact.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US4: a two-rule condition and a tag step send each customer down the right branch', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `89${suffix}`;
  const dubai = { phone: `+97156${suffix.slice(-6)}5`, name: `Rana ${suffix.slice(-4)}` };
  const abuDhabi = { phone: `+97158${suffix.slice(-6)}6`, name: `Omar ${suffix.slice(-4)}` };
  const keyword = `deliver${suffix.slice(-5)}`;
  const attribute = `city_${suffix.slice(-5)}`;
  const tag = `vip-${suffix.slice(-5)}`;
  const question = `Which city should we deliver to, ${suffix.slice(-4)}?`;
  const yes = 'Good news: we deliver to your city.';
  const no = 'Sorry, we do not deliver there yet.';
  const diag = collectDiagnostics(page);
  const inbound = (who: { phone: string; name: string }, body: string) =>
    execSync(`npm run mock:inbound -- --from ${who.phone} --name "${who.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sentTo = async (who: { phone: string }) => {
    const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; to: string; text?: string }> };
    return sent.messages.filter((m) => m.phoneNumberId === phoneNumberId && m.to === who.phone.slice(1)).map((m) => m.text);
  };
  const waitForSent = (who: { phone: string }, text: string) => expect.poll(async () => (await sentTo(who)).includes(text), { timeout: 30_000 }).toBe(true);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  expect(
    (await page.request.post('/api/numbers', { headers, data: { label: `Flows US4 ${suffix}`, wabaId: `MOCK_WABA_F4${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);
  expect((await page.request.post('/api/attributes', { headers, data: { key: attribute, label: 'City', type: 'TEXT' } })).status()).toBe(201);
  expect((await page.request.post('/api/tags', { headers, data: { name: tag } })).status()).toBe(201);

  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow', exact: true }).click();
  await page.getByLabel('Flow name').fill(`Delivery check ${suffix}`);
  await page.getByRole('button', { name: 'Create flow', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}$/);

  // Built from the end, so every "goes to" target exists when it is chosen.
  await page.getByRole('button', { name: 'Add Message step', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill(yes);
  await page.getByRole('button', { name: 'Add Message step', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill(no);

  await page.getByRole('button', { name: 'Add Condition step', exact: true }).click();
  await page.getByLabel('Go to Yes when').selectOption('any');
  await expect(page.locator('#rule-0-kind option[value="attribute"]')).toBeEnabled();
  await page.getByLabel('Rule 1 checks').selectOption('attribute');
  await page.getByLabel('Rule 1 attribute').selectOption(attribute);
  await page.getByLabel('Rule 1 value').fill('dubai');
  await page.getByRole('button', { name: 'Add rule', exact: true }).click();
  await page.getByLabel('Rule 2 checks').selectOption('attribute');
  await page.getByLabel('Rule 2 attribute').selectOption(attribute);
  await page.getByLabel('Rule 2 value').fill('sharjah');
  await page.getByLabel('If yes, go to').selectOption('message-1');
  await page.getByLabel('If no, go to').selectOption('message-2');

  await page.getByRole('button', { name: 'Add Tags step', exact: true }).click();
  await page.getByLabel(`Add tag ${tag}`).check();
  await page.getByLabel('Then go to').selectOption('condition-1');

  await page.getByRole('button', { name: 'Add Question step', exact: true }).click();
  await page.getByLabel('Question', { exact: true }).fill(question);
  await page.getByLabel('Answer name').fill('city');
  await page.getByLabel('Save to contact attribute (optional)').selectOption(attribute);
  await page.getByLabel('Message after a wrong answer').fill('Please type the name of your city.');
  await page.getByLabel('After a valid answer, go to').selectOption('tags-1');
  await page.getByRole('button', { name: 'Make this the start', exact: true }).click();

  await page.getByRole('button', { name: 'Add keyword', exact: true }).click();
  await page.getByLabel('Keywords 1').fill(keyword);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByTestId('no-problems')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible({ timeout: 15_000 });

  // Yes branch: Dubai matches the first rule.
  inbound(dubai, keyword);
  await waitForSent(dubai, question);
  inbound(dubai, 'Dubai');
  await waitForSent(dubai, yes);

  // No branch: Abu Dhabi matches neither rule.
  inbound(abuDhabi, keyword);
  await waitForSent(abuDhabi, question);
  inbound(abuDhabi, 'Abu Dhabi');
  await waitForSent(abuDhabi, no);
  expect(await sentTo(abuDhabi)).not.toContain(yes);

  // The tag step ran before the condition: the contact has the tag in live chat.
  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: dubai.name });
  await diag.check(() => expect(row).toBeVisible({ timeout: 15_000 }));
  await row.click();
  await expect(page.getByRole('complementary', { name: 'Contact' })).toContainText(tag, { timeout: 15_000 });
});
