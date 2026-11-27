import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MOCK_META, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T066 (feature 008, quickstart US5 row): connect the mock catalog and copy its 40 products, search
// them, then send one product, a product list and the catalog in a chat; an out-of-stock product
// shows as unavailable in the picker.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('US5: connect the catalog, search it, and send products in a chat', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const phoneNumberId = `82${suffix}`;
  const customer = `+97152${suffix}1`;
  const name = `Shopper ${suffix.slice(-4)}`;
  await signInAsAdmin(page);
  const number = await page.request.post('/api/numbers', {
    headers: await csrfHeaders(page),
    data: { label: `Catalog ${suffix}`, wabaId: `MOCK_WABA_C${suffix}`, phoneNumberId, accessToken: 'mock-token' },
  });
  expect(number.status()).toBe(201);

  // 1. Connect the mock catalog (unless an earlier spec did) and wait for the first copy.
  await page.goto('/catalog');
  const state = (await (await page.request.get('/api/catalog/connection')).json()) as { connection: unknown };
  if (!state.connection) await page.getByRole('list', { name: 'Catalogs found' }).getByRole('button', { name: 'Connect' }).first().click();
  await expect(page.getByTestId('catalog-connection')).toContainText('40 products', { timeout: 90_000 });

  // 2. Search by SKU.
  await page.getByLabel('Search products').fill('shp-105');
  await expect(page.getByTestId('catalog-products').locator('tbody tr')).toHaveCount(1);

  // 3. A customer writes; the agent sends products.
  execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --text "Do you have shoes?" --phone-number-id ${phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  await page.getByRole('button', { name: 'Send products' }).click();
  let dialog = page.getByRole('dialog', { name: 'Send products' });
  await dialog.getByPlaceholder('Search by name or SKU').fill('shp-103');
  await expect(dialog.getByTestId('product-results')).toContainText('Out of stock');
  await expect(dialog.getByTestId('product-results').getByRole('radio')).toBeDisabled();
  await dialog.getByPlaceholder('Search by name or SKU').fill('shp-101');
  await dialog.getByTestId('product-results').getByRole('radio').check();
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('product-message-PRODUCT')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Send products' }).click();
  dialog = page.getByRole('dialog', { name: 'Send products' });
  await dialog.getByLabel('What to send').selectOption('list');
  await dialog.getByLabel('Header').fill('New in');
  await dialog.getByLabel('Text', { exact: true }).fill('Pick one');
  await dialog.getByPlaceholder('Search by name or SKU').fill('shp-11');
  await dialog.getByTestId('product-results').getByRole('checkbox').nth(0).check();
  await dialog.getByTestId('product-results').getByRole('checkbox').nth(1).check();
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('product-message-PRODUCT_LIST')).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Send products' }).click();
  dialog = page.getByRole('dialog', { name: 'Send products' });
  await dialog.getByLabel('What to send').selectOption('catalog');
  await dialog.getByLabel('Text', { exact: true }).fill('Browse our catalog');
  await dialog.getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.getByTestId('product-message-CATALOG')).toBeVisible({ timeout: 15_000 });

  // They reach Meta as interactive product messages.
  await expect
    .poll(
      async () => {
        const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; interactive?: { type?: string } }> };
        return sent.messages.filter((m) => m.phoneNumberId === phoneNumberId).map((m) => m.interactive?.type).filter(Boolean).sort();
      },
      { timeout: 30_000 },
    )
    .toEqual(['catalog_message', 'product', 'product_list']);
});
