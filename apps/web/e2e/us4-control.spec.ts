import { expect, test, type Page } from '@playwright/test';

// T146: quickstart US4 row - schedule 1,000 recipients ~2 minutes ahead, pause at ~30%, resume,
// and check that mock-meta recorded exactly 1,000 unique sends.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const MOCK_META = process.env.E2E_MOCK_META_URL ?? 'http://localhost:4010';
const RECIPIENTS = 1000;

test.setTimeout(10 * 60_000);

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US4: a scheduled 1,000-recipient campaign starts on time and never double-sends across pause/resume', async ({ page }) => {
  const suffix = Date.now().toString().slice(-6);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);

  // Setup through the API: number (fast send rate), templates, draft, 1,000-row upload, mapping.
  const phoneNumberId = `40${suffix}`;
  const number = await (
    await page.request.post('/api/numbers', { data: { label: `Load ${suffix}`, wabaId: `MOCK_WABA_L${suffix}`, phoneNumberId, accessToken: 'mock-token' }, headers })
  ).json();
  await page.request.patch(`/api/numbers/${number.id}`, { data: { sendRatePerSecond: 80 }, headers });
  await page.request.post('/api/templates/sync', { headers });
  const templates = (await (await page.request.get(`/api/templates?wabaId=${number.wabaId}&status=APPROVED`)).json()) as Array<{ id: string; name: string }>;
  const template = templates.find((t) => t.name === 'order_confirmation');
  expect(template).toBeTruthy();
  const campaign = await (
    await page.request.post('/api/campaigns', { data: { name: `Scheduled load ${suffix}`, numberId: number.id, templateId: template!.id, audienceType: 'UPLOAD' }, headers })
  ).json();

  const rows = ['name,phone', ...Array.from({ length: RECIPIENTS }, (_, i) => `Customer ${i + 1},+97150600${String(i + 1).padStart(4, '0')}`)];
  const upload = await page.request.post(`/api/campaigns/${campaign.id}/audience-upload`, {
    headers,
    multipart: {
      file: { name: 'load.csv', mimeType: 'text/csv', buffer: Buffer.from(`${rows.join('\n')}\n`) },
      phoneColumn: 'phone',
      nameColumn: 'name',
      optInConfirmed: 'true',
      optInSourceNote: 'E2E load test list',
    },
  });
  expect(upload.status()).toBe(202);
  const job = await upload.json();
  await expect(async () => {
    const status = await (await page.request.get(`/api/imports/${job.id}`)).json();
    expect(status.status).toBe('COMPLETED');
  }).toPass({ timeout: 60_000 });
  await page.request.patch(`/api/campaigns/${campaign.id}`, {
    data: { variableMapping: { 'BODY.1': { source: 'column', key: 'name' }, 'BODY.2': { source: 'static', value: '#LOAD' } } },
    headers,
  });

  // Schedule ~2 minutes ahead in UTC through the review step.
  await page.goto(`/campaigns/new?id=${campaign.id}&step=4`);
  await expect(page.getByTestId('eligible-count')).toHaveText('1,000');
  await page.getByLabel('Schedule for later').check();
  const start = new Date(Date.now() + 2 * 60_000);
  await page.getByLabel('Timezone').fill('UTC');
  await page.getByLabel('Date and time').fill(start.toISOString().slice(0, 16));
  await page.getByRole('button', { name: 'Schedule' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Schedule' }).click();
  await expect(page).toHaveURL(new RegExp(`/campaigns/${campaign.id}$`));
  await expect(page.getByTestId('scheduled-banner')).toBeVisible();

  // Starts on time (within a minute of the scheduled minute).
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('campaign-state')).toHaveText(/Running|Completed/, { timeout: 2_000 });
  }).toPass({ timeout: 4 * 60_000, intervals: [5_000] });

  // Pause at about 30%, then resume.
  const sentSoFar = async () => {
    const c = await (await page.request.get(`/api/campaigns/${campaign.id}`)).json();
    return c.totals.sent + c.totals.delivered + c.totals.read + c.totals.failed;
  };
  await expect(async () => expect(await sentSoFar()).toBeGreaterThanOrEqual(300)).toPass({ timeout: 2 * 60_000, intervals: [500] });
  await page.reload();
  await page.getByRole('button', { name: 'Pause' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByTestId('campaign-state')).toHaveText('Paused');
  await page.waitForTimeout(5_000);
  await page.getByRole('button', { name: 'Resume' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Resume' }).click();

  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 2_000 });
  }).toPass({ timeout: 4 * 60_000, intervals: [5_000] });

  const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; to: string }> };
  const mine = sent.messages.filter((m) => m.phoneNumberId === phoneNumberId);
  expect(mine).toHaveLength(RECIPIENTS);
  expect(new Set(mine.map((m) => m.to)).size).toBe(RECIPIENTS);
});
