import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// 004 T080: quickstart US6 row - a Hand to AI agent step added in the flow editor passes the chat to
// an agent (one that is not the number's agent), which answers the customer's next message.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const FIRST = 'Let me get our assistant.';
const OPENING = 'Our assistant takes over now.';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('AI US6: a Hand to AI agent step passes the chat to an agent, which answers next', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `33${suffix}`;
  const customer = { phone: `+97155${suffix.slice(-6)}1`, name: `Nadia ${suffix.slice(-4)}` };
  const agentName = `Concierge ${suffix}`;
  const keyword = `assist${suffix.slice(-5)}`;
  const agentReply = `Hello from the agent ${suffix}`;
  const diag = collectDiagnostics(page);
  const inbound = (body: string) =>
    execSync(`npm run mock:inbound -- --from ${customer.phone} --name "${customer.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sent = async (text: string) => {
    const all = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
    return all.messages.filter((m) => m.phoneNumberId === phoneNumberId && (m.text ?? '').includes(text)).length;
  };

  const rule = { when: { systemContains: `Name: ${agentName}` }, reply: { message: agentReply } };
  expect((await page.request.post(`${MOCK_META}/mock/ai/rules`, { data: [rule] })).ok()).toBe(true);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  expect((await page.request.post('/api/numbers', { headers, data: { label: `AI US6 ${suffix}`, wabaId: `MOCK_WABA_AI6${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status()).toBe(201);

  // A published agent that no number has: only the flow brings it into the chat.
  const created = await page.request.post('/api/ai-agents', { headers, data: { name: agentName } });
  expect(created.status()).toBe(201);
  const agent = (await created.json()) as { id: string; config: Record<string, unknown> };
  expect((await page.request.put(`/api/ai-agents/${agent.id}/draft`, { headers, data: { config: { ...agent.config, goal: 'Help customers after the welcome flow.' }, draftRevision: 0 } })).status()).toBe(200);
  expect((await page.request.post(`/api/ai-agents/${agent.id}/publish`, { headers })).status()).toBe(200);

  // Build the flow in the editor: a message, then Hand to AI agent.
  await page.goto('/flows');
  await page.getByRole('button', { name: 'New flow', exact: true }).click();
  await page.getByLabel('Flow name').fill(`Welcome ${suffix}`);
  await page.getByRole('button', { name: 'Create flow', exact: true }).click();
  await expect(page).toHaveURL(/\/flows\/[0-9a-f-]{36}$/);
  // The agent step first, then the message that leads to it (made the start), as the 003 specs do:
  // a new step is selected, so no click on the canvas is needed.
  await page.getByRole('button', { name: 'Add Hand to AI agent step', exact: true }).click();
  await page.getByLabel('AI agent', { exact: true }).selectOption({ label: agentName });
  await page.getByLabel('Message before the agent takes over (optional)').fill(OPENING);
  await page.getByRole('button', { name: 'Add Message step', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill(FIRST);
  await page.getByLabel('Then go to').selectOption('ai-agent-1');
  await page.getByRole('button', { name: 'Make this the start', exact: true }).click();
  await page.getByRole('button', { name: 'Add keyword', exact: true }).click();
  await page.getByLabel('Keywords 1').fill(keyword);
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await expect(page.getByTestId('no-problems')).toBeVisible();
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible({ timeout: 15_000 });

  // The keyword runs the flow; then the agent answers the next message.
  inbound(keyword);
  await diag.check(() => expect.poll(() => sent(OPENING), { timeout: 30_000 }).toBe(1));
  expect(await sent(FIRST)).toBe(1);
  inbound('hello, can you help me?');
  await diag.check(() => expect.poll(() => sent(agentReply), { timeout: 30_000 }).toBe(1));

  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Open/ }).click();
  const row = page.getByTestId('conversation-row').filter({ hasText: customer.name });
  await diag.check(() => expect(row).toBeVisible({ timeout: 15_000 }));
  await row.click();
  await expect(page.getByTestId('ai-banner')).toContainText(agentName);
});
