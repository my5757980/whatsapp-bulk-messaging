import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// T075: quickstart US8 row - run two sessions, open analytics mode in the editor, and check that the
// totals bar and the step counts match the analytics API.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US8: analytics mode shows the totals and step counts from the API', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `92${suffix}`;
  const keyword = `stats${suffix.slice(-5)}`;

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);
  expect(
    (await page.request.post('/api/numbers', { headers, data: { label: `Flows US8 ${suffix}`, wabaId: `MOCK_WABA_F8${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status(),
  ).toBe(201);

  // A published one-step flow made through the API (the editor has its own specs).
  const created = await page.request.post('/api/flows', { headers, data: { name: `Analytics demo ${suffix}` } });
  const flowId = ((await created.json()) as { id: string }).id;
  const graph = {
    version: 1,
    start: 'hello',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
    steps: [{ id: 'hello', type: 'message', text: `Hello from analytics ${suffix.slice(-4)}`, next: null }],
  };
  expect((await page.request.put(`/api/flows/${flowId}/draft`, { headers, data: { graph, draftRevision: 0 } })).status()).toBe(200);
  expect((await page.request.post(`/api/flows/${flowId}/publish`, { headers })).status()).toBe(200);

  for (const n of [1, 2]) {
    execSync(`npm run mock:inbound -- --from +97156${suffix.slice(-6)}${n} --name "Visitor ${n}" --phone-number-id ${phoneNumberId} --text "${keyword}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  }
  type Analytics = { totals: { started: number; completed: number }; steps: Array<{ stepId: string; entered: number; continued: number; dropped: number }> };
  const fetchAnalytics = async () => (await (await page.request.get(`/api/flows/${flowId}/analytics?period=7d`)).json()) as Analytics;
  await expect.poll(async () => (await fetchAnalytics()).totals.completed, { timeout: 30_000 }).toBe(2);
  const analytics = await fetchAnalytics();

  await page.goto(`/flows/${flowId}`);
  await page.getByRole('button', { name: 'Analytics', exact: true }).click();
  const totals = page.getByTestId('analytics-totals');
  await expect(totals).toContainText(`Started ${analytics.totals.started}`);
  await expect(totals).toContainText(`Completed ${analytics.totals.completed}`);
  const hello = analytics.steps.find((s) => s.stepId === 'hello')!;
  await expect(page.getByTestId('flow-step').filter({ hasText: 'Hello from analytics' }).getByTestId('step-stats')).toHaveText(
    `entered ${hello.entered} · moved on ${hello.continued} · dropped ${hello.dropped}`,
  );
  expect(hello.entered).toBe(2);
});
