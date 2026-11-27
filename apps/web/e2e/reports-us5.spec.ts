import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T061 (feature 009, quickstart US5 row): "send to every row" sends three messages to a number on three
// rows; two CLI replies give replied 2 and the reply rate; the three reports for this month each download.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('US5: every row, replies and the reports', async ({ page }) => {
  test.setTimeout(360_000);
  const suffix = Date.now().toString().slice(-6);
  const name = `order_update_${suffix}`;
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Reports', suffix);

  // 1. An approved utility template, made through the API.
  const created = await page.request.post('/api/templates', {
    headers: await csrfHeaders(page),
    data: { wabaId: number.wabaId, name, language: 'en_US', category: 'UTILITY', body: { text: 'Your order {{1}} is on its way.', examples: ['A-1'] } },
  });
  expect(created.status(), await created.text()).toBe(201);
  const templateId = ((await created.json()) as { id: string }).id;
  await expect.poll(async () => ((await (await page.request.get(`/api/templates/${templateId}`)).json()) as { status: string }).status, { timeout: 60_000 }).toBe('APPROVED');

  // 2. A campaign that sends to every row: Sara is on three rows.
  const sara = `+97154${suffix}1`;
  const omar = `+97154${suffix}2`;
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(`Orders ${suffix}`);
  await page.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: `${name} · en_US · Utility` });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/campaigns/')),
    page.getByTestId('every-row').getByRole('checkbox').check(),
  ]);
  await page.getByLabel(/Recipient list/).setInputFiles({
    name: 'orders.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`name,phone,order\nSara,${sara},A-1\nSara,${sara},A-2\nOmar,${omar},B-1\nSara,${sara},A-3\n`),
  });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E orders list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText('4 rows processed', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('order');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByTestId('eligible-count')).toHaveText('4');
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  const campaignUrl = page.url();
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });
  await expect(async () => {
    const toSara = (await sentMessages(page, number.phoneNumberId, name)).filter((m) => `+${m.to}` === sara);
    expect(toSara.map((m) => m.components?.[0]?.parameters?.[0]?.text).sort()).toEqual(['A-1', 'A-2', 'A-3']);
  }).toPass({ timeout: 60_000 });

  // 3. Both contacts reply once their messages are delivered.
  await expect(async () => {
    const res = await page.request.get(`/api/campaigns/${campaignUrl.split('/').pop()}/messages?status=DELIVERED`);
    const read = await page.request.get(`/api/campaigns/${campaignUrl.split('/').pop()}/messages?status=READ`);
    const total = ((await res.json()) as { page: { total: number } }).page.total + ((await read.json()) as { page: { total: number } }).page.total;
    expect(total).toBe(4);
  }).toPass({ timeout: 60_000 });
  for (const [phone, text] of [[sara, 'Thanks!'], [omar, 'Got it']] as const) {
    execSync(`npm run mock:inbound -- --from ${phone} --text "${text}" --phone-number-id ${number.phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  }
  await expect(async () => {
    await page.goto(`${campaignUrl}/report`);
    await expect(page.getByTestId('replied')).toHaveText('2', { timeout: 3_000 });
  }).toPass({ timeout: 120_000, intervals: [10_000] });
  await expect(page.getByTestId('reply-rate')).toHaveText('100.0%');
  await expect(page.getByTestId('multi-message')).toHaveText('1');

  // 4. The reports for this month, each downloaded.
  await page.getByRole('link', { name: 'Reports', exact: true }).click();
  await expect(page).toHaveURL(/\/reports$/);
  await expect(page.getByTestId('overview-numbers')).toContainText(number.label);
  for (const [tab, report] of [['Overview', 'overview'], ['Team', 'team'], ['Opt-ins', 'consent']] as const) {
    await page.getByRole('tab', { name: tab }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId(`download-${report}`).click()]);
    expect(download.suggestedFilename()).toMatch(new RegExp(`^${report}-report-\\d{4}-\\d{2}-\\d{2}-to-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
  }
  await expect(page.getByTestId('consent-table')).toContainText('Upload confirmation');
});
