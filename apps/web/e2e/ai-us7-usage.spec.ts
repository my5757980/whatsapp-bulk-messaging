import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// 004 T087: quickstart US7 row - with two AI replies left this month (set on the AI usage page),
// three questions get two answers; the third goes to Waiting for agent with the limit note, the
// usage page shows the count and admins get the alert. The month's count is shared with the other
// specs, so the limit is set to what is used so far plus two, and restored afterwards.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const HOURS = 'We open 9 to 6, Sunday to Thursday.';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('AI US7: the monthly limit stops the agent, hands the chat over and alerts admins', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `22${suffix}`;
  const customer = { phone: `+97150${suffix.slice(-6)}2`, name: `Karim ${suffix.slice(-4)}` };
  const limitMessage = `Our team will reply soon ${suffix}.`;
  const diag = collectDiagnostics(page);
  const inbound = (body: string) =>
    execSync(`npm run mock:inbound -- --from ${customer.phone} --name "${customer.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sent = async (text: string) => {
    const all = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
    return all.messages.filter((m) => m.phoneNumberId === phoneNumberId && (m.text ?? '').includes(text)).length;
  };
  const limitAlerts = async () => {
    const list = (await (await page.request.get('/api/notifications')).json()) as Array<{ type: string; title: string }>;
    return list.filter((n) => n.type === 'AI_USAGE' && n.title === 'AI reply limit reached').length;
  };

  // The fake model answers from the knowledge.
  expect((await page.request.post(`${MOCK_META}/mock/ai/rules`, { data: [] })).ok()).toBe(true);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  const number = await page.request.post('/api/numbers', { headers, data: { label: `AI US7 ${suffix}`, wabaId: `MOCK_WABA_AI7${suffix}`, phoneNumberId, accessToken: 'mock-token' } });
  expect(number.status()).toBe(201);
  const numberId = ((await number.json()) as { id: string }).id;
  const created = await page.request.post('/api/ai-agents', { headers, data: { name: `Budget ${suffix}` } });
  const agent = (await created.json()) as { id: string; config: Record<string, unknown> };
  expect((await page.request.post(`/api/ai-agents/${agent.id}/knowledge/answers`, { headers, data: { question: 'What are your opening hours?', answer: HOURS } })).status()).toBe(201);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/draft`, { headers, data: { config: { ...agent.config, goal: 'Answer questions about the shop.' }, draftRevision: 0 } })).status()).toBe(200);
  expect((await page.request.post(`/api/ai-agents/${agent.id}/publish`, { headers })).status()).toBe(200);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/numbers`, { headers, data: { numberIds: [numberId] } })).status()).toBe(200);

  const original = await (await page.request.get('/api/ai-settings')).json();
  const used = ((await (await page.request.get('/api/ai-usage')).json()) as { replies: number }).replies;
  const alertsBefore = await limitAlerts();
  try {
    // Two replies left this month, with a message for the customer at the limit.
    await page.goto('/ai-usage');
    await page.getByLabel('AI replies per month').fill(String(used + 2));
    await page.getByLabel('Message to the customer at the limit (optional)').fill(limitMessage);
    await page.getByRole('button', { name: 'Save limits' }).click();
    await expect(page.getByText('AI limits saved')).toBeVisible();

    inbound('what are your opening hours?');
    await diag.check(() => expect.poll(() => sent(HOURS), { timeout: 30_000 }).toBe(1));
    inbound('and are you open on Sunday?');
    await diag.check(() => expect.poll(() => sent(HOURS), { timeout: 30_000 }).toBe(2));
    inbound('one more question please');
    await diag.check(() => expect.poll(() => sent(limitMessage), { timeout: 30_000 }).toBe(1));
    expect(await sent(HOURS)).toBe(2);

    // The usage page shows the count against the limit.
    await page.reload();
    await expect(page.getByTestId('usage-replies')).toContainText(`${used + 2}`);
    await expect(page.getByTestId('usage-replies')).toContainText(`of ${used + 2}`);

    // Live chat: the chat waits for a person with the limit note.
    await page.goto('/inbox');
    await page.getByRole('tab', { name: /Waiting for agent/ }).click();
    const row = page.getByTestId('conversation-row').filter({ hasText: customer.name });
    await diag.check(() => expect(row).toBeVisible({ timeout: 15_000 }));
    await row.click();
    await expect(page.getByTestId('timeline').getByTestId('chat-item').filter({ hasText: 'AI reply limit reached' })).toContainText('Internal note');

    // Admins were alerted at 100%.
    await expect.poll(limitAlerts, { timeout: 15_000 }).toBeGreaterThan(alertsBefore);
  } finally {
    await page.request.put('/api/ai-settings', { headers, data: original });
  }
});
