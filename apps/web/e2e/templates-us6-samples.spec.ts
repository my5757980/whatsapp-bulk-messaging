import { expect, test } from '@playwright/test';
import { connectNumber, signInAsAdmin } from './growth-helpers';

// T069 (feature 009, quickstart US6 row): Templates → Samples → Food → Order update → Use this sample
// gives a draft that opens in the editor with the sample's text and examples.

test('US6: a food order update sample becomes a filled draft', async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Samples', suffix);

  await page.goto('/templates');
  await page.getByRole('link', { name: 'Samples', exact: true }).click();
  await expect(page).toHaveURL(/\/templates\/samples$/);
  await page.getByLabel('Industry').selectOption('FOOD');
  await page.getByLabel('Purpose').selectOption('ORDER_UPDATE');
  await page.getByLabel('Language').selectOption('en');
  const card = page.getByTestId('sample-food-order-update');
  await expect(card).toBeVisible();
  await expect(page.locator('[data-testid^="sample-"]')).toHaveCount(1);
  await expect(card).toContainText('is being prepared');

  await card.getByRole('button', { name: 'Use this sample' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Account').selectOption(number.wabaId);
  const name = `food_order_update_${suffix}`;
  await dialog.getByLabel('Template name').fill(name);
  await dialog.getByRole('button', { name: 'Make the draft' }).click();

  await expect(page).toHaveURL(/\/templates\/new\?from=[0-9a-f-]{36}&draft=1$/);
  await expect(page.getByRole('heading', { name: 'Review template draft' })).toBeVisible();
  await expect(page.getByLabel('Template name')).toHaveValue(name);
  await expect(page.getByLabel('Message text')).toHaveValue(/is being prepared/);
  await expect(page.getByLabel('Sample for {{1}}')).toHaveValue('Omar');
});
