import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T039: quickstart US3 row - a flow hands over: the chat waits for an agent with the answer and the
// flow's note in the timeline. A member starts a flow from an Open chat; the banner shows it, and
// the member's reply stops the flow and removes the banner.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US3: hand-over waits for an agent; a member starts a flow and a reply stops it', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `88${suffix}`;
  const first = { phone: `+97154${suffix.slice(-6)}3`, name: `Noor ${suffix.slice(-4)}` };
  const second = { phone: `+97155${suffix.slice(-6)}4`, name: `Zaid ${suffix.slice(-4)}` };
  const keyword = `refund${suffix.slice(-5)}`;
  const flowName = `Refunds ${suffix}`;
  const question = `What is your order number, ${suffix.slice(-4)}?`;
  const diag = collectDiagnostics(page);
  const inbound = (who: { phone: string; name: string }, body: string) =>
    execSync(`npm run mock:inbound -- --from ${who.phone} --name "${who.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sentCount = async (text: string) => {
    const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
    return sent.messages.filter((m) => m.phoneNumberId === phoneNumberId && m.text === text).length;
  };

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  expect(
    (await page.request.post('/api/numbers', { headers, data: { label: `Flows US3 ${suffix}`, wabaId: `MOCK_WABA_F3${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);

  // A published flow made through the API (the editor has its own specs): a question, then hand-over.
  const created = await page.request.post('/api/flows', { headers, data: { name: flowName } });
  expect(created.status()).toBe(201);
  const flowId = ((await created.json()) as { id: string }).id;
  const graph = {
    version: 1,
    start: 'ask',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
    steps: [
      { id: 'ask', type: 'question', text: question, answer: { kind: 'text' }, answerName: 'order', retryText: 'Please send your order number.', next: 'handover' },
      { id: 'handover', type: 'handover', note: 'Refund request from the flow' },
    ],
  };
  expect((await page.request.put(`/api/flows/${flowId}/draft`, { headers, data: { graph, draftRevision: 0 } })).status()).toBe(200);
  expect((await page.request.post(`/api/flows/${flowId}/publish`, { headers })).status()).toBe(200);

  // Hand-over: the chat waits for an agent, with the answer and the flow's note.
  inbound(first, keyword);
  await expect.poll(() => sentCount(question), { timeout: 30_000 }).toBe(1);
  inbound(first, 'Order 5521');
  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Waiting for agent/ }).click();
  const waiting = page.getByTestId('conversation-row').filter({ hasText: first.name });
  await diag.check(() => expect(waiting).toBeVisible({ timeout: 15_000 }));
  await waiting.click();
  const timeline = page.getByTestId('timeline');
  await expect(timeline.getByTestId('chat-item').filter({ hasText: question })).toContainText('Automatic');
  await expect(timeline.getByTestId('chat-item').filter({ hasText: 'Order 5521' })).toHaveCount(1);
  await expect(timeline.getByText('Refund request from the flow')).toBeVisible();
  await expect(page.getByTestId('flow-banner')).toHaveCount(0);

  // A member starts the flow from an Open chat; the banner shows it until the member replies.
  inbound(second, 'Hello, I need help');
  await page.getByRole('tab', { name: /Open/ }).click();
  const open = page.getByTestId('conversation-row').filter({ hasText: second.name });
  await diag.check(() => expect(open).toBeVisible({ timeout: 15_000 }));
  await open.click();
  await page.getByRole('button', { name: 'Start a flow', exact: true }).click();
  await page.getByLabel('Flow', { exact: true }).selectOption({ label: flowName });
  await page.getByRole('button', { name: 'Start flow', exact: true }).click();
  await diag.check(() => expect(page.getByTestId('flow-banner')).toContainText(flowName, { timeout: 15_000 }));
  await expect(timeline.getByTestId('chat-item').filter({ hasText: question })).toHaveCount(1, { timeout: 15_000 });

  await page.getByLabel('Reply').fill('I will help you myself.');
  const [response] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/messages')),
    page.getByLabel('Reply').press('Enter'),
  ]);
  expect(response.status(), await response.text()).toBe(202);
  await diag.check(() => expect(page.getByTestId('flow-banner')).toHaveCount(0, { timeout: 15_000 }));
});
