import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T045 (feature 010, quickstart US3 row): create a global attribute, map it in a campaign, insert it in a
// chat reply and a saved reply, change the value, and the deletion refusal while it is used.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('US3: a global attribute in a campaign and in chat replies, a new value and the deletion refusal', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const key = `hours_${suffix}`;
  await signInAsAdmin(page);

  // 1. Create it in settings.
  await page.goto('/settings/global-attributes');
  await page.getByLabel('Name').fill(key);
  await page.getByLabel('Description (optional)').fill('Opening hours');
  await page.getByLabel('Value').fill('9 am to 9 pm');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  const row = page.getByTestId('global-attribute').filter({ hasText: `{global:${key}}` });
  await expect(row.getByTestId('global-attribute-value')).toHaveText('9 am to 9 pm');

  // 2. Map it to a template variable; the sent message carries the value.
  const number = await connectNumber(page, 'Globals', suffix);
  await page.goto('/templates');
  await page.getByRole('button', { name: /Sync from Meta/ }).click();
  await expect(page.getByText(/Templates synced/)).toBeVisible({ timeout: 90_000 });
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(`E2E globals ${suffix}`);
  await page.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: 'order_confirmation · en_US · Utility' });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  const customer = `+97154${suffix}7`;
  await page.getByLabel(/Recipient list/).setInputFiles({ name: 'globals.csv', mimeType: 'text/csv', buffer: Buffer.from(`name,phone\nGlobal Sara,${customer}\n`) });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E globals list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText('1 rows processed', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
  const body2 = page.getByTestId('mapping-BODY.2');
  await body2.getByLabel('Source').selectOption('global');
  await body2.getByLabel('Global attribute').selectOption(key);
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  await expect
    .poll(async () => (await sentMessages(page, number.phoneNumberId, 'order_confirmation')).flatMap((m) => m.components?.flatMap((c) => c.parameters?.map((p) => p.text) ?? []) ?? []), { timeout: 60_000 })
    .toContain('9 am to 9 pm');

  // 3. Change the value; a chat reply inserts the new one.
  await page.goto('/settings/global-attributes');
  await row.getByRole('button', { name: 'Edit' }).click();
  await row.getByLabel('Value').fill('10 am to 10 pm');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByTestId('global-attribute-value')).toHaveText('10 am to 10 pm');

  execSync(`npm run mock:inbound -- --from ${customer} --name "Global Sara" --text "When do you open?" --phone-number-id ${number.phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await page.goto('/inbox');
  const chat = page.getByTestId('conversation-row').filter({ hasText: 'Global Sara' });
  await expect(chat).toBeVisible({ timeout: 15_000 });
  await chat.click();
  await page.getByLabel('Reply').fill('We are open ');
  await page.getByRole('button', { name: 'Insert global attribute' }).click();
  await page.getByRole('menuitem', { name: new RegExp(key) }).click();
  await expect(page.getByLabel('Reply')).toHaveValue('We are open 10 am to 10 pm');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('timeline').getByTestId('chat-item').filter({ hasText: 'We are open 10 am to 10 pm' })).toBeVisible({ timeout: 15_000 });

  // 4. A saved reply uses the placeholder, so deleting the attribute is refused while it exists.
  const headers = await csrfHeaders(page);
  const reply = await page.request.post('/api/canned-messages', { headers, data: { name: `Hours ${suffix}`, type: 'TEXT', text: `We are open {global:${key}}` } });
  expect(reply.status()).toBe(201);
  await page.goto('/settings/global-attributes');
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(row.getByRole('alert')).toContainText(`Saved reply "Hours ${suffix}"`);
  await expect(row).toBeVisible();
});
