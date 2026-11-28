import { expect, test } from '@playwright/test';
import { connectNumber, sentMessages, signInAsAdmin } from './growth-helpers';

// T043 (feature 009, quickstart US3 row): an offer template built in the editor and approved on mock-meta,
// a campaign ending in two days with codes from an upload column, each recipient's own code and the end
// time on mock-meta, and the row without a code skipped as "Missing offer code".

test('US3: an offer template, codes from an upload column and the row without a code skipped', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const name = `weekend_offer_${suffix}`;
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Offers', suffix);

  // 1. The editor: the offer type, its heading and example code, and the website button.
  await page.goto('/templates/new');
  await page.getByLabel('Type').selectOption('LIMITED_TIME_OFFER');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(name);
  await page.getByLabel('Message text').fill('Hi {{1}}, 20% off until Sunday.');
  await page.getByLabel('Sample for {{1}}').fill('Sara');
  await page.getByLabel('Offer heading (up to 16 characters)').fill('Weekend deal');
  await page.getByLabel('Example offer code (up to 15 characters)').fill('WKND20');
  await page.getByLabel('Button 1 link').fill('https://shop.example.com/offer');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  // 2. The campaign: three uploaded rows, the last one without a code.
  const phones = [1, 2, 3].map((n) => `+97155${suffix}${n}`);
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(`Offer ${suffix}`);
  await page.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: `${name} · en_US · Marketing` });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel(/Recipient list/).setInputFiles({
    name: 'offer.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`name,phone,code\nAmna,${phones[0]},AMNA10\nBilal,${phones[1]},BILAL25\nChen,${phones[2]},\n`),
  });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E offer list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText('3 rows processed', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  // 3. Mapping: the name; the offer ends in two days (the default) and the codes come from "code".
  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
  const offer = page.getByTestId('offer-config');
  await offer.getByLabel('Code', { exact: true }).selectOption('column');
  await offer.getByLabel('Column').selectOption('code');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // 4. Review: two recipients can be sent, one has no code.
  await expect(page.getByTestId('offer-summary')).toContainText('codes from the “code” column');
  await expect(page.getByTestId('eligible-count')).toHaveText('2');
  await expect(page.getByText('Missing offer code').locator('..')).toContainText('1');
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });

  // 5. Each recipient got their own code and the end time; the row without a code was not sent.
  await expect(async () => {
    const sent = new Map((await sentMessages(page, number.phoneNumberId, name)).map((m) => [`+${m.to}`, JSON.stringify(m.components)]));
    expect(sent.get(phones[0]!)).toContain('"coupon_code":"AMNA10"');
    expect(sent.get(phones[1]!)).toContain('"coupon_code":"BILAL25"');
    expect(sent.get(phones[0]!)).toContain('expiration_time_ms');
    expect(sent.has(phones[2]!)).toBe(false);
  }).toPass({ timeout: 60_000 });
  await expect(page.getByText('Missing offer code')).toBeVisible();
});
