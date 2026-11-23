import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// 004 T031: quickstart US1 row - a manager builds an agent in the editor (goal, a written answer, the
// number), publishes it, and a customer's question is answered from the knowledge by the fake model,
// shown in live chat as automatic with the agent's name. A question without an answer lands under
// Unanswered.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const ANSWER = 'Delivery to Sharjah costs AED 50.';
const UNSURE = "I don't have that information yet. I can connect you with our team.";

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('AI US1: an agent built in the editor answers from its knowledge and collects unanswered questions', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `77${suffix}`;
  const numberLabel = `AI US1 ${suffix}`;
  const customer = { phone: `+97156${suffix.slice(-6)}5`, name: `Huda ${suffix.slice(-4)}` };
  const agentName = `Sales ${suffix}`;
  const unknown = `Do you sell garden furniture ${suffix.slice(-4)}?`;
  const diag = collectDiagnostics(page);
  const inbound = (body: string) =>
    execSync(`npm run mock:inbound -- --from ${customer.phone} --name "${customer.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sent = async (text: string) => {
    const all = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
    return all.messages.filter((m) => m.phoneNumberId === phoneNumberId && (m.text ?? '').includes(text)).length;
  };

  // The fake model answers from the knowledge in the request when no rule says otherwise.
  expect((await page.request.post(`${MOCK_META}/mock/ai/rules`, { data: [] })).ok()).toBe(true);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  expect(
    (await page.request.post('/api/numbers', { headers, data: { label: numberLabel, wabaId: `MOCK_WABA_AI1${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);

  // Build the agent in the editor.
  await page.getByRole('link', { name: 'AI agents' }).click();
  await expect(page).toHaveURL(/\/ai-agents$/);
  await page.getByRole('button', { name: 'New agent' }).click();
  await page.getByLabel('Name', { exact: true }).fill(agentName);
  await page.getByRole('button', { name: 'Create agent' }).click();
  await diag.check(() => expect(page).toHaveURL(/\/ai-agents\/[0-9a-f-]{36}$/, { timeout: 15_000 }));
  const agentUrl = page.url();

  await expect(page.getByTestId('problems')).toContainText('Write what the agent is for.');
  await page.getByLabel('Goal', { exact: true }).fill('Answer questions about our furniture and delivery.');
  // The draft saves itself; the server then reports nothing blocking.
  await expect(page.getByTestId('no-problems')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved');

  await page.getByRole('tab', { name: 'Knowledge' }).click();
  await page.getByLabel('Question', { exact: true }).fill('How much is delivery to Sharjah?');
  await page.getByLabel('Answer', { exact: true }).fill(ANSWER);
  await page.getByRole('button', { name: 'Add answer' }).click();
  const row = page.getByTestId('knowledge-row').filter({ hasText: 'How much is delivery to Sharjah?' });
  await expect(row).toContainText('Ready');
  await expect(page.getByTestId('knowledge-summary')).toContainText('reads all of it for every reply');

  await page.getByRole('checkbox', { name: new RegExp(numberLabel) }).check();
  await page.getByRole('button', { name: 'Save numbers' }).click();
  await expect(page.getByText('Numbers saved')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible();

  // The customer asks; the agent introduces itself and answers from the knowledge.
  inbound('how much is shipping to sharjah?');
  await diag.check(() => expect.poll(() => sent(ANSWER), { timeout: 30_000 }).toBe(1));
  expect(await sent(`Hi, I'm ${agentName}, a virtual assistant.`)).toBe(1);

  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Open/ }).click();
  const chat = page.getByTestId('conversation-row').filter({ hasText: customer.name });
  await diag.check(() => expect(chat).toBeVisible({ timeout: 15_000 }));
  await chat.click();
  const reply = page.getByTestId('timeline').getByTestId('chat-item').filter({ hasText: ANSWER });
  await expect(reply).toContainText(`Automatic · ${agentName}`);

  // A question the knowledge does not cover is answered honestly and collected for the team.
  inbound(unknown);
  await diag.check(() => expect.poll(() => sent(UNSURE), { timeout: 30_000 }).toBe(1));
  await page.goto(agentUrl);
  await page.getByRole('tab', { name: 'Unanswered' }).click();
  await expect(page.getByTestId('unanswered-question').filter({ hasText: unknown })).toContainText('Asked once');
});
