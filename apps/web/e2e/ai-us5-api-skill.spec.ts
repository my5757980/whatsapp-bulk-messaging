import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// 004 T073: quickstart US5 row - a manager stores a secret (shown masked) and adds an "Order status"
// skill whose Authorization header uses it, runs the test request, and publishes. The fake model calls
// the skill; the company system cannot be reached (a .invalid address never resolves), so the customer
// gets an offer of a person and no invented status, and live chat shows the skill that was tried.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const FALLBACK_TEXT = 'I cannot check orders right now. I can connect you with our team.';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('AI US5: an API skill with a masked secret, a test request, and a failed lookup that offers a person', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `33${suffix}`;
  const customer = { phone: `+97150${suffix.slice(-6)}1`, name: `Reem ${suffix.slice(-4)}` };
  const agentName = `Orders ${suffix}`;
  const secretValue = `tok-live-${suffix}`;
  const diag = collectDiagnostics(page);
  const inbound = (body: string) =>
    execSync(`npm run mock:inbound -- --from ${customer.phone} --name "${customer.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sentTexts = async () => {
    const all = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
    return all.messages.filter((m) => m.phoneNumberId === phoneNumberId).map((m) => m.text ?? '');
  };

  // The fake model calls the skill for this agent's customer, then answers from the tool result.
  const only = { systemContains: `Name: ${agentName}` };
  const rules = [
    { when: { ...only, lastUserContains: 'order', hasToolResult: false }, toolCall: { name: 'skill_skill_1', input: { order_number: '10234' } } },
    { when: { ...only, hasToolResult: true }, reply: { message: FALLBACK_TEXT } },
  ];
  expect((await page.request.post(`${MOCK_META}/mock/ai/rules`, { data: rules })).ok()).toBe(true);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  const number = await page.request.post('/api/numbers', { headers, data: { label: `AI US5 ${suffix}`, wabaId: `MOCK_WABA_AI5${suffix}`, phoneNumberId, accessToken: 'mock-token' } });
  expect(number.status()).toBe(201);
  const numberId = ((await number.json()) as { id: string }).id;
  const created = await page.request.post('/api/ai-agents', { headers, data: { name: agentName } });
  expect(created.status()).toBe(201);
  const agent = (await created.json()) as { id: string; config: Record<string, unknown> };
  expect((await page.request.put(`/api/ai-agents/${agent.id}/draft`, { headers, data: { config: { ...agent.config, goal: 'Help customers track their orders.' }, draftRevision: 0 } })).status()).toBe(200);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/numbers`, { headers, data: { numberIds: [numberId] } })).status()).toBe(200);

  // A secret, shown masked once stored.
  await page.goto(`/ai-agents/${agent.id}`);
  await page.getByRole('tab', { name: 'Skills' }).click();
  await page.getByLabel('Secret name').fill('Shop token');
  await page.getByLabel('Secret value').fill(secretValue);
  await page.getByRole('button', { name: 'Store secret' }).click();
  await diag.check(() => expect(page.getByTestId('secrets-panel')).toContainText('Shop token ••••••••', { timeout: 15_000 }));
  await expect(page.getByLabel('Secret value')).toHaveValue('');

  // The skill: one input, the secret in the Authorization header, one mapped field.
  await page.getByRole('button', { name: 'Add a skill' }).click();
  await page.getByLabel('Skill name').fill('Order status');
  await page.getByLabel('When to use it').fill('When the customer asks where their order is.');
  await page.getByRole('button', { name: 'Add an input' }).click();
  await page.getByLabel('Input 1 key').fill('order_number');
  await page.getByLabel('Input 1 description').fill('The order number, for example 10234');
  await page.getByLabel('Address').fill('https://shop.invalid/api/orders/{input:order_number}');
  await page.getByRole('button', { name: 'Add a header' }).click();
  await page.getByLabel('Header 1 name').fill('Authorization');
  await page.getByLabel('Header 1 value').fill('Bearer ');
  await page.getByLabel('Insert a secret into header 1').selectOption({ label: 'Shop token' });
  await expect(page.getByLabel('Header 1 value')).toHaveValue(/^Bearer \{secret:[0-9a-f-]{36}\}$/);
  await page.getByRole('button', { name: 'Add a field' }).click();
  await page.getByLabel('Field 1 path').fill('order.status');
  await page.getByLabel('Field 1 name').fill('status');

  // The test request uses the same client: the address cannot be reached.
  await page.getByLabel('order_number', { exact: true }).fill('10234');
  await page.getByRole('button', { name: 'Run test' }).click();
  await diag.check(() => expect(page.getByTestId('skill-test-result')).toContainText('Failed', { timeout: 30_000 }));

  await expect(page.getByTestId('no-problems')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible();
  await expect(page.locator('body')).not.toContainText(secretValue);

  // The customer asks; the lookup fails, so the agent offers a person and invents no status.
  inbound('where is my order 10234?');
  await diag.check(() => expect.poll(async () => (await sentTexts()).filter((t) => t.includes(FALLBACK_TEXT)).length, { timeout: 45_000 }).toBe(1));
  expect((await sentTexts()).some((t) => /shipped|delivered/i.test(t))).toBe(false);

  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Open/ }).click();
  const row = page.getByTestId('conversation-row').filter({ hasText: customer.name });
  await diag.check(() => expect(row).toBeVisible({ timeout: 15_000 }));
  await row.click();
  const answer = page.getByTestId('timeline').getByTestId('chat-item').filter({ hasText: FALLBACK_TEXT });
  await expect(answer.getByTestId('ai-used')).toContainText('Used 1 skill');
});
