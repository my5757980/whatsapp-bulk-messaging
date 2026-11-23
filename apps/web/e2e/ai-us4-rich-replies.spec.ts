import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// 004 T066: quickstart US4 row - in the Skills tab a manager shares a price list and lets the agent
// remember "city"; the customer asks for the file (it arrives with a caption) and states a city, which
// the profile panel shows with a journey entry by the agent.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const FILE_CAPTION = 'Here is our price list.';
const CITY_REPLY = 'Thanks! We deliver to Al Ain.';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('AI US4: the agent sends a shared file and remembers the customer city', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `44${suffix}`;
  const customer = { phone: `+97156${suffix.slice(-6)}9`, name: `Sami ${suffix.slice(-4)}` };
  const agentName = `Rich ${suffix}`;
  const fileName = `Price list ${suffix}.pdf`;
  const diag = collectDiagnostics(page);
  const inbound = (body: string) =>
    execSync(`npm run mock:inbound -- --from ${customer.phone} --name "${customer.name}" --phone-number-id ${phoneNumberId} --text "${body}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const sent = async (type: string, text: string) => {
    const all = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; type: string; text?: string }> };
    return all.messages.filter((m) => m.phoneNumberId === phoneNumberId && m.type === type && (m.text ?? '').includes(text)).length;
  };

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  const number = await page.request.post('/api/numbers', { headers, data: { label: `AI US4 ${suffix}`, wabaId: `MOCK_WABA_AI4${suffix}`, phoneNumberId, accessToken: 'mock-token' } });
  expect(number.status()).toBe(201);
  const numberId = ((await number.json()) as { id: string }).id;
  const upload = await page.request.post('/api/media-library', {
    headers,
    multipart: { file: { name: fileName, mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n') }, displayName: fileName },
  });
  expect(upload.status(), await upload.text()).toBe(201);
  const mediaId = ((await upload.json()) as { id: string }).id;
  const attribute = await page.request.post('/api/attributes', { headers, data: { key: 'city', label: 'City', type: 'TEXT' } });
  expect([201, 409]).toContain(attribute.status());

  // The fake model sends the file when asked and remembers the city (this agent only).
  const only = { systemContains: `Name: ${agentName}` };
  const rules = [
    { when: { ...only, lastUserContains: 'price list' }, reply: { message: FILE_CAPTION, mediaId } },
    { when: { ...only, lastUserContains: 'I live in' }, reply: { message: CITY_REPLY, remember: [{ key: 'city', value: 'Al Ain' }] } },
  ];
  expect((await page.request.post(`${MOCK_META}/mock/ai/rules`, { data: rules })).ok()).toBe(true);

  const created = await page.request.post('/api/ai-agents', { headers, data: { name: agentName } });
  expect(created.status()).toBe(201);
  const agent = (await created.json()) as { id: string; config: Record<string, unknown> };
  expect((await page.request.put(`/api/ai-agents/${agent.id}/draft`, { headers, data: { config: { ...agent.config, goal: 'Help customers with prices and delivery.' }, draftRevision: 0 } })).status()).toBe(200);
  expect((await page.request.put(`/api/ai-agents/${agent.id}/numbers`, { headers, data: { numberIds: [numberId] } })).status()).toBe(200);

  // Share the file and allow "city" in the Skills tab, then publish.
  await page.goto(`/ai-agents/${agent.id}`);
  await page.getByRole('tab', { name: 'Skills' }).click();
  await page.getByRole('button', { name: 'Choose file' }).click();
  const picker = page.getByRole('dialog');
  await picker.getByRole('list', { name: 'Media library' }).getByRole('button', { name: new RegExp(fileName) }).click();
  await picker.getByRole('button', { name: `Use "${fileName}"` }).click();
  await page.getByLabel('When to send it').fill('When someone asks for prices');
  await page.getByLabel('Attribute', { exact: true }).selectOption('city');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('What it holds').fill('The city the customer lives in');
  await expect(page.getByTestId('no-problems')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('save-status')).toHaveText('All changes saved', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible();

  // The customer asks for the file; it arrives as a document with the caption.
  inbound('can you send me the price list?');
  await diag.check(() => expect.poll(() => sent('document', FILE_CAPTION), { timeout: 30_000 }).toBe(1));

  // The customer states a city; the profile shows it with a journey entry by the agent.
  inbound('I live in Al Ain');
  await diag.check(() => expect.poll(() => sent('text', CITY_REPLY), { timeout: 30_000 }).toBe(1));
  await page.goto('/inbox');
  await page.getByRole('tab', { name: /Open/ }).click();
  const row = page.getByTestId('conversation-row').filter({ hasText: customer.name });
  await diag.check(() => expect(row).toBeVisible({ timeout: 15_000 }));
  await row.click();
  const profile = page.getByRole('complementary', { name: 'Contact' });
  await expect(profile).toContainText('city: Al Ain');
  await diag.check(() => expect(profile.getByTestId('journey')).toContainText(`city changed to Al Ain by AI agent "${agentName}"`, { timeout: 15_000 }));
});
