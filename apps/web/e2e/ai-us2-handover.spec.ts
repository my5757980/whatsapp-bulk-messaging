import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// 004 T050: quickstart US2 row - while the agent answers, live chat shows it and the sources it used.
// A customer asks for a person: one closing reply, the chat waits for an agent with the summary note,
// and the AI banner goes. After a member takes and closes the chat the agent answers again; STOP
// gets no reply.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const HOURS = 'We open 9 to 6, Sunday to Thursday.';
const CLOSING = 'Of course. A member of our team will reply here shortly.';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('AI US2: the agent hands over to a person, answers again after the chat is closed, and STOP gets no reply', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `66${suffix}`;
  const customer = { phone: `+97152${suffix.slice(-6)}6`, name: `Omar ${suffix.slice(-4)}` };
  const agentName = `Helper ${suffix}`;
  const summary = `Customer ${suffix} wants to talk to a person.`;
  const diag = collectDiagnostics(page);
  const inbound = (body: string) =>
    execSync(`npm run mock:inbound -- --from ${customer.phone} --name "${customer.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sentTexts = async () => {
    const all = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
    return all.messages.filter((m) => m.phoneNumberId === phoneNumberId).map((m) => m.text ?? '');
  };
  const sent = async (text: string) => (await sentTexts()).filter((t) => t.includes(text)).length;

  // The fake model hands over when this agent's customer asks for a person; otherwise it answers
  // from the knowledge in the request.
  const rule = { when: { lastUserContains: 'someone from your team', systemContains: `Name: ${agentName}` }, reply: { message: CLOSING, handOver: { reason: 'customer_asked', summary } } };
  expect((await page.request.post(`${MOCK_META}/mock/ai/rules`, { data: [rule] })).ok()).toBe(true);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  const number = await page.request.post('/api/numbers', { headers, data: { label: `AI US2 ${suffix}`, wabaId: `MOCK_WABA_AI2${suffix}`, phoneNumberId, accessToken: 'mock-token' } });
  expect(number.status()).toBe(201);
  const numberId = ((await number.json()) as { id: string }).id;

  // A published agent made through the API (the editor has its own spec).
  const created = await page.request.post('/api/ai-agents', { headers, data: { name: agentName } });
  expect(created.status()).toBe(201);
  const agent = (await created.json()) as { id: string; config: Record<string, unknown> };
  expect((await page.request.post(`/api/ai-agents/${agent.id}/knowledge/answers`, { headers, data: { question: 'What are your opening hours?', answer: HOURS } })).status()).toBe(201);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/draft`, { headers, data: { config: { ...agent.config, goal: 'Answer questions about our shop.' }, draftRevision: 0 } })).status()).toBe(200);
  expect((await page.request.post(`/api/ai-agents/${agent.id}/publish`, { headers })).status()).toBe(200);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/numbers`, { headers, data: { numberIds: [numberId] } })).status()).toBe(200);

  // The agent answers; live chat shows that it is answering and which knowledge it used.
  inbound('what are your opening hours?');
  await diag.check(() => expect.poll(() => sent(HOURS), { timeout: 30_000 }).toBe(1));
  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Open/ }).click();
  const openRow = page.getByTestId('conversation-row').filter({ hasText: customer.name });
  await diag.check(() => expect(openRow).toBeVisible({ timeout: 15_000 }));
  await openRow.click();
  await diag.check(() => expect(page.getByTestId('ai-banner')).toContainText(agentName, { timeout: 15_000 }));
  const timeline = page.getByTestId('timeline');
  const answer = timeline.getByTestId('chat-item').filter({ hasText: HOURS });
  await expect(answer).toContainText(`Automatic · ${agentName}`);
  await expect(answer.getByTestId('ai-used')).toContainText('Used 1 source');

  // Asking for a person hands over: one closing reply, Waiting for agent, the note, no banner.
  inbound('can I talk to someone from your team please');
  await diag.check(() => expect.poll(() => sent(CLOSING), { timeout: 30_000 }).toBe(1));
  await page.getByRole('tab', { name: /Waiting for agent/ }).click();
  const waitingRow = page.getByTestId('conversation-row').filter({ hasText: customer.name });
  await diag.check(() => expect(waitingRow).toBeVisible({ timeout: 15_000 }));
  await waitingRow.click();
  await expect(timeline.getByTestId('chat-item').filter({ hasText: summary })).toContainText('Internal note');
  await expect(page.getByTestId('ai-banner')).toHaveCount(0);

  // A member takes and closes the chat; the agent answers the next message again.
  await page.getByRole('button', { name: 'Take chat' }).click();
  await expect(page.getByText('Taken · you')).toBeVisible();
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByRole('button', { name: 'Take chat' })).toBeVisible();
  inbound('are you open on Sunday?');
  await diag.check(() => expect.poll(() => sent(HOURS), { timeout: 30_000 }).toBe(2));

  // STOP is handled by the 001 consent rules and gets no AI reply.
  const before = (await sentTexts()).length;
  inbound('STOP');
  // Longer than the 2-second debounce and a reply from the fake model.
  await page.waitForTimeout(8_000);
  expect((await sentTexts()).length).toBe(before);
});
