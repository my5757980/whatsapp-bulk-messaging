import { expect, test, type Page } from '@playwright/test';
import { MOCK_META, connectNumber, sentMessages, signInAsAdmin } from './growth-helpers';

// T052 (feature 009, quickstart US4 row): a utility template with a 1-minute time-to-live and delivery held
// on mock-meta shows "Not delivered in time" (the e2e run shortens the sweep's grace and interval), and a
// document campaign with an address per row: Check media lists the bad row; after the fix it launches.
const PDF = Buffer.from('%PDF-1.4\n%%EOF\n');
const FILE = `${MOCK_META}/mock/files/invoice.pdf`;

/** Uploads the rows, maps BODY.1 to the name column and opens the mapping step. */
async function campaignWithUpload(page: Page, args: { name: string; numberLabel: string; templateName: string; csv: string; rows: number }) {
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(args.name);
  await page.getByLabel('Send from').selectOption({ label: `${args.numberLabel} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: `${args.templateName} · en_US · Utility` });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel(/Recipient list/).setInputFiles({ name: 'rows.csv', mimeType: 'text/csv', buffer: Buffer.from(args.csv) });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E invoices list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText(`${args.rows} rows processed`, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
}

async function sendNow(page: Page) {
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });
}

test('US4: not delivered in time, and media addresses checked before launch', async ({ page }) => {
  test.setTimeout(420_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Expiry', suffix);

  // 1. A utility template with a 1-minute time-to-live, applied by Meta.
  const ttlName = `order_ready_${suffix}`;
  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(ttlName);
  await page.getByLabel('Category').selectOption('UTILITY');
  await page.getByLabel('Message text').fill('Your order {{1}} is ready.');
  await page.getByLabel('Sample for {{1}}').fill('A-100');
  await page.getByLabel('Time-to-live in minutes (optional)').fill('1');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  // 2. Delivery is held on mock-meta: the message stays "sent" until the sweep marks it.
  expect((await page.request.post(`${MOCK_META}/mock/hold-delivery`, { data: { phoneNumberId: number.phoneNumberId, on: true } })).status()).toBe(200);
  await campaignWithUpload(page, { name: `Expiry ${suffix}`, numberLabel: number.label, templateName: ttlName, csv: `name,phone\nHeld,+97156${suffix}1\n`, rows: 1 });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await sendNow(page);
  await expect(async () => {
    await page.reload();
    await expect(page.getByText('Not delivered in time')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 180_000, intervals: [10_000] });
  await page.request.post(`${MOCK_META}/mock/hold-delivery`, { data: { phoneNumberId: number.phoneNumberId, on: false } });

  // 3. A document template, and a campaign with an address per row.
  const docName = `invoice_${suffix}`;
  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(docName);
  await page.getByLabel('Category').selectOption('UTILITY');
  await page.getByLabel('Header', { exact: true }).selectOption('DOCUMENT');
  await page.getByLabel("Sample document for Meta's review").setInputFiles({ name: 'sample.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(page.getByText('Sample uploaded.')).toBeVisible();
  await page.getByLabel('Message text').fill('Hi {{1}}, your invoice is attached.');
  await page.getByLabel('Sample for {{1}}').fill('Sara');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  const phones = [1, 2].map((n) => `+97156${suffix}${n + 1}`);
  await campaignWithUpload(page, {
    name: `Invoices ${suffix}`,
    numberLabel: number.label,
    templateName: docName,
    csv: `name,phone,invoice_url,invoice_url_fixed\nAmna,${phones[0]},${FILE},${FILE}\nBilal,${phones[1]},https://10.0.0.5/invoice.pdf,${FILE}\n`,
    rows: 2,
  });
  const media = page.getByTestId('media-source');
  await media.getByLabel('Where the document comes from').selectOption('column');
  await media.getByLabel('Column').selectOption('invoice_url');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // 4. Check media lists the bad row (the second row of the list, as upload errors count them).
  await page.getByRole('button', { name: 'Check media' }).click();
  const problem = page.getByTestId('media-problem');
  await expect(problem).toHaveCount(1, { timeout: 30_000 });
  await expect(problem).toContainText('https://10.0.0.5/invoice.pdf');
  await expect(problem).toContainText('Not a public address · row 2');

  // 5. The fix: the other column. Every address works, and it launches with `link`.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.getByTestId('media-source').getByLabel('Column').selectOption('invoice_url_fixed');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('button', { name: 'Check media' }).click();
  await expect(page.getByTestId('media-check-result')).toContainText('Every address works', { timeout: 30_000 });
  await sendNow(page);
  await expect(async () => {
    const sent = await sentMessages(page, number.phoneNumberId, docName);
    expect(sent).toHaveLength(2);
    for (const m of sent) expect(JSON.stringify(m.components)).toContain(`"link":"${FILE}"`);
  }).toPass({ timeout: 60_000 });
});
