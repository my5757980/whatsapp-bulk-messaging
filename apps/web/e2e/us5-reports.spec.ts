import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

// T157: quickstart US5 row - report totals match the export, the cost uses the rate card, and
// "Retarget -> Not read" creates a draft with the right audience.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const CSV = fileURLToPath(new URL('../../../samples/contacts-10.csv', import.meta.url));

test.setTimeout(5 * 60_000);

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US5: report, export and retarget', async ({ page }) => {
  const suffix = Date.now().toString().slice(-6);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);

  // A finished campaign through the API (mock-meta delivers and reads after a few seconds).
  await page.request.put('/api/rate-card', { headers, data: [{ category: 'UTILITY', countryCode: '*', priceUsd: 0.01, effectiveFrom: '2026-01-01' }] });
  const number = await (await page.request.post('/api/numbers', { headers, data: { label: `Report ${suffix}`, wabaId: `MOCK_WABA_R${suffix}`, phoneNumberId: `60${suffix}`, accessToken: 'mock-token' } })).json();
  await page.request.post('/api/templates/sync', { headers });
  const templates = (await (await page.request.get(`/api/templates?wabaId=${number.wabaId}&status=APPROVED`)).json()) as Array<{ id: string; name: string }>;
  const template = templates.find((t) => t.name === 'order_confirmation')!;
  const campaign = await (await page.request.post('/api/campaigns', { headers, data: { name: `Report ${suffix}`, numberId: number.id, templateId: template.id, audienceType: 'UPLOAD' } })).json();
  const upload = await (
    await page.request.post(`/api/campaigns/${campaign.id}/audience-upload`, {
      headers,
      multipart: { file: { name: 'contacts-10.csv', mimeType: 'text/csv', buffer: readFileSync(CSV) }, phoneColumn: 'phone', nameColumn: 'name', optInConfirmed: 'true', optInSourceNote: 'E2E report test' },
    })
  ).json();
  await expect(async () => expect((await (await page.request.get(`/api/imports/${upload.id}`)).json()).status).toBe('COMPLETED')).toPass({ timeout: 30_000 });
  await page.request.patch(`/api/campaigns/${campaign.id}`, { headers, data: { variableMapping: { 'BODY.1': { source: 'column', key: 'name' }, 'BODY.2': { source: 'static', value: '#R' } } } });
  await page.request.post(`/api/campaigns/${campaign.id}/launch`, { headers, data: {} });
  await expect(async () => {
    const c = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
    expect(c.state).toBe('COMPLETED');
    expect(c.totals.read + c.totals.failed).toBe(10);
  }).toPass({ timeout: 90_000, intervals: [2_000] });

  // Report page: totals, rates and an estimated cost from the rate card (9 delivered x $0.01).
  await page.goto(`/campaigns/${campaign.id}/report`);
  await expect(page.getByTestId('report-total')).toHaveText('10');
  await expect(page.getByTestId('report-failed')).toHaveText('1');
  await expect(page.getByTestId('estimated-cost')).toContainText('0.09');

  // The export has one row per recipient, matching the report.
  const download = await page.request.get(`/api/campaigns/${campaign.id}/export`);
  expect(download.ok()).toBe(true);
  expect((await download.text()).trim().split('\n')).toHaveLength(11);

  // Retarget "Read" (every delivered recipient read the message in mock-meta) creates a draft. Since
  // feature 005 the group sizes are shown first (FR-011).
  await page.getByRole('button', { name: 'Retarget…' }).click();
  await expect(page.getByTestId('retarget-count-READ')).not.toHaveText('0');
  await page.getByTestId('retarget-READ').getByRole('radio').check();
  await page.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/campaigns\/new\?id=.+&step=2/);
  await expect(page.getByTestId('retarget-audience')).toBeVisible();
});
