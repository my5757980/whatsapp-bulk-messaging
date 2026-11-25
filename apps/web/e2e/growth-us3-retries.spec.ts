import { expect, test } from '@playwright/test';
import { connectNumber, signInAsAdmin } from './growth-helpers';

// T036 (feature 005, quickstart US3 row). mock-meta fails numbers ending 1016 once with 131016 (may
// pass), 0000 with 131026 (never retried) and 1049 with 131049 (held back). A campaign with 2 retry
// rounds schedules round 1 for the 1016 number only; cancelling it lets the campaign complete.
test('US3: retry rounds take only failures that may pass', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const s3 = suffix.slice(-3);
  const phones = [`+97150${s3}1016`, `+97150${s3}0000`, `+97150${s3}1049`];
  const campaignName = `E2E retries ${suffix}`;

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Retries', suffix);
  await page.goto('/templates');
  await page.getByRole('button', { name: /Sync from Meta/ }).click();
  // The sync reads every connected account one by one; wait for it to finish, not for an older account's row.
  await expect(page.getByText(/Templates synced/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('order_confirmation').first()).toBeVisible();

  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(campaignName);
  await page.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: 'order_confirmation · en_US · Utility' });
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await page.getByLabel(/Recipient list/).setInputFiles({
    name: 'retries.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`name,phone\n${phones.map((p, i) => `Retry ${i + 1},${p}`).join('\n')}\n`),
  });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E retries list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText('3 rows processed', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
  const body2 = page.getByTestId('mapping-BODY.2');
  await body2.getByLabel('Source').selectOption('static');
  await body2.getByLabel('Text').fill('#E2E');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  // Two rounds: 30 minutes, then 1 hour.
  await page.getByLabel('Retry rounds').selectOption('2');
  await expect(page.getByLabel('Round 1 waits')).toHaveValue('30');
  await expect(page.getByLabel('Round 2 waits')).toHaveValue('60');
  await expect(page.getByTestId('retry-plan-saved')).toBeVisible();
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);

  // Round 1 is scheduled for the one failure that may pass; one message is held back.
  const round = page.getByTestId('retry-round-1');
  await expect(round).toContainText('Scheduled', { timeout: 60_000 });
  await expect(round.getByTestId('retry-round-recipients')).toHaveText('1');
  await expect(page.getByTestId('held-back-count')).toHaveText('1');
  await expect(page.getByTestId('campaign-state')).toHaveText('Running');

  await round.getByRole('button', { name: 'Cancel round' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel round' }).click();
  await expect(round).toContainText('Cancelled');
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 60_000 });

  // The list across campaigns shows it too.
  await page.goto('/campaigns/retries');
  await page.getByLabel('Status').selectOption('CANCELLED');
  await expect(page.getByRole('row', { name: new RegExp(campaignName) })).toBeVisible();
});
