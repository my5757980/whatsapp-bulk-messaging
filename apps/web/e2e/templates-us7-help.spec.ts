import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T075 (feature 009, quickstart US7 row): guidelines per editor section, the meaning and action next to
// failure reasons, and the per-person marketing limit note in the review step and in the results.
// mock-meta fails template sends to numbers ending in 0000 (131026) and 1049 (131049, held back).

test('US7: guidelines, meanings of failures and the per-person limit note', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Help', suffix);

  // 1. The editor shows the guidelines of the sections that matter for the type.
  await page.goto('/templates/new');
  const panel = page.getByTestId('guidelines-panel');
  for (const section of ['category', 'variables', 'buttons']) await expect(panel.getByTestId(`guidelines-${section}`)).toBeVisible();
  await expect(panel.getByTestId('guidelines-rejections')).toBeVisible();
  await page.getByLabel('Type').selectOption('CAROUSEL');
  await expect(panel.getByTestId('guidelines-carousel')).toBeVisible();
  await page.getByLabel('Type').selectOption('AUTHENTICATION');
  await expect(panel.getByTestId('guidelines-authentication')).toBeVisible();
  await expect(panel.getByTestId('guidelines-variables')).toHaveCount(0);
  await panel.getByTestId('guidelines-authentication').locator('summary').click();
  await expect(panel.getByTestId('guidelines-authentication')).toContainText('is your verification code');

  // 2. A marketing template, made through the API.
  const name = `spring_news_${suffix}`;
  const created = await page.request.post('/api/templates', {
    headers: await csrfHeaders(page),
    data: { wabaId: number.wabaId, name, language: 'en_US', category: 'MARKETING', body: { text: 'Hi {{1}}, our spring collection is here.', examples: ['Sara'] } },
  });
  expect(created.status(), await created.text()).toBe(201);
  const templateId = ((await created.json()) as { id: string }).id;
  await expect.poll(async () => ((await (await page.request.get(`/api/templates/${templateId}`)).json()) as { status: string }).status, { timeout: 60_000 }).toBe('APPROVED');

  // 3. The review step explains the per-person limit for marketing templates.
  const head = `+97150${suffix.slice(-3)}`;
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(`Spring ${suffix}`);
  await page.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: `${name} · en_US · Marketing` });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel(/Recipient list/).setInputFiles({
    name: 'spring.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`name,phone\nUnreachable,${head}0000\nLimited,${head}1049\nReader,${head}2222\n`),
  });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E help list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText('3 rows processed', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByTestId('frequency-cap-note')).toContainText('marketing messages each person receives');
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  const campaignUrl = page.url();
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });

  // 4. The results show what each failure means, and how many the limit held back.
  await expect(async () => {
    await page.goto(`${campaignUrl}/report`);
    await expect(page.getByTestId('frequency-cap-note')).toContainText('1 held back', { timeout: 3_000 });
  }).toPass({ timeout: 90_000, intervals: [5_000] });
  const meanings = page.getByTestId('error-meaning');
  await expect(meanings.first()).toContainText('What to do:');
  await expect(page.getByText('Check the number with the customer')).toBeVisible();
});
