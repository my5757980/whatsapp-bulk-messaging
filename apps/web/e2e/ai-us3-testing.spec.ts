import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// 004 T059: quickstart US3 row - the preview answers with the draft and sends nothing; a test number
// meets the draft while another phone meets the published version; restoring version 1 brings its
// settings back into the draft.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const HOURS = 'We open 9 to 6, Sunday to Thursday.';
const PUBLISHED_GOAL = 'Answer questions about our shop.';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('AI US3: preview the draft, meet it from a test number, and restore version 1', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `55${suffix}`;
  const tester = { phone: `+97150${suffix.slice(-6)}7`, name: `Tester ${suffix.slice(-4)}` };
  const customer = { phone: `+97154${suffix.slice(-6)}8`, name: `Layla ${suffix.slice(-4)}` };
  const marker = `DRAFT-${suffix}`;
  const draftReply = `Draft reply ${suffix}`;
  const diag = collectDiagnostics(page);
  const inbound = (who: { phone: string; name: string }, body: string) =>
    execSync(`npm run mock:inbound -- --from ${who.phone} --name "${who.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sent = async (text: string) => {
    const all = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; to?: string; text?: string }> };
    return all.messages.filter((m) => m.phoneNumberId === phoneNumberId && (m.text ?? '').includes(text)).length;
  };

  // The fake model answers the draft (its goal carries the marker) with a reply of its own; the
  // published version answers from the knowledge.
  expect((await page.request.post(`${MOCK_META}/mock/ai/rules`, { data: [{ when: { systemContains: marker }, reply: { message: draftReply } }] })).ok()).toBe(true);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  const number = await page.request.post('/api/numbers', { headers, data: { label: `AI US3 ${suffix}`, wabaId: `MOCK_WABA_AI3${suffix}`, phoneNumberId, accessToken: 'mock-token' } });
  expect(number.status()).toBe(201);
  const numberId = ((await number.json()) as { id: string }).id;

  // Version 1 is published; the draft then moves on (made through the API, the editor has its own spec).
  const created = await page.request.post('/api/ai-agents', { headers, data: { name: `Shop ${suffix}` } });
  expect(created.status()).toBe(201);
  const agent = (await created.json()) as { id: string; config: Record<string, unknown> };
  expect((await page.request.post(`/api/ai-agents/${agent.id}/knowledge/answers`, { headers, data: { question: 'What are your opening hours?', answer: HOURS } })).status()).toBe(201);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/draft`, { headers, data: { config: { ...agent.config, goal: PUBLISHED_GOAL }, draftRevision: 0 } })).status()).toBe(200);
  expect((await page.request.post(`/api/ai-agents/${agent.id}/publish`, { headers })).status()).toBe(200);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/numbers`, { headers, data: { numberIds: [numberId] } })).status()).toBe(200);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/draft`, { headers, data: { config: { ...agent.config, goal: `${PUBLISHED_GOAL} ${marker}` }, draftRevision: 1 } })).status()).toBe(200);

  // The preview answers with the draft and sends nothing.
  await page.goto(`/ai-agents/${agent.id}`);
  await page.getByRole('tab', { name: 'Test' }).click();
  await page.getByLabel('Message as the customer').fill('what are your opening hours?');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await diag.check(() => expect(page.getByTestId('preview-reply')).toContainText(draftReply, { timeout: 30_000 }));
  expect(await sent(draftReply)).toBe(0);

  // A test number meets the draft; another phone meets version 1.
  await page.getByLabel('Test number 1').fill(tester.phone);
  await page.getByRole('button', { name: 'Save test numbers' }).click();
  await expect(page.getByTestId('saved-test-numbers')).toContainText(tester.phone);
  inbound(tester, 'what are your opening hours?');
  await diag.check(() => expect.poll(() => sent(draftReply), { timeout: 30_000 }).toBe(1));
  inbound(customer, 'what are your opening hours?');
  await diag.check(() => expect.poll(() => sent(HOURS), { timeout: 30_000 }).toBe(1));

  // Restoring version 1 brings its goal back into the draft.
  await page.getByRole('tab', { name: 'Versions' }).click();
  const v1 = page.getByTestId('version-row').filter({ hasText: 'Version 1' });
  await expect(v1).toContainText('Customers meet this one');
  await v1.getByRole('button', { name: 'Restore' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Restore' }).click();
  await diag.check(() => expect(page.getByLabel('Goal', { exact: true })).toHaveValue(PUBLISHED_GOAL, { timeout: 15_000 }));
});
