import { expect, test } from '@playwright/test';
import { MOCK_META, connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T065 (feature 006, quickstart US6 row): cart reminders on the mock Shopify store. The first
// reminder waits at least 30 minutes, so its sending (with the tracked cart link) and recovery are
// covered by the integration test; here the dashboard turns reminders on, checkouts become carts,
// a checkout without a phone is skipped, and an order closes the cart.
test('US6: abandoned carts from the mock store', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const shop = `cart${suffix}`;
  const templateName = `cart_reminder_${suffix}`;

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Carts', suffix);

  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(templateName);
  await page.getByLabel('Category').selectOption('MARKETING');
  await page.getByLabel('Message text').fill('You left something in your cart. Finish here: {{1}}');
  await page.getByLabel('Sample for {{1}}').fill('https://example.com/cart');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  const numberId = numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id;
  const created = await page.request.post('/api/stores', {
    data: { platform: 'SHOPIFY', baseUrl: `${MOCK_META}/shopify/${shop}`, numberId, defaultCountry: 'AE', customerTag: 'shopify', credentials: { clientId: 'cart-client', clientSecret: `cart-secret-${suffix}` } },
    headers: await csrfHeaders(page),
  });
  expect(created.status()).toBe(201);
  const storeId = ((await created.json()) as { id: string }).id;
  expect((await page.request.patch(`/api/stores/${storeId}`, { data: { consentIsWhatsapp: true }, headers: await csrfHeaders(page) })).status()).toBe(200);

  // 1. Turn reminders on with the tracked cart link.
  await page.goto(`/integrations/stores/${storeId}`);
  const card = page.getByTestId('automation-CART_REMINDER');
  await expect(card).toContainText('Customers who agree to marketing at checkout count as opted in.');
  const step = card.getByTestId('cart-step-1');
  await step.getByLabel('Reminder 1 template').selectOption({ label: `${templateName} · en_US` });
  const map = step.getByTestId('cart-map-1-BODY.1');
  await map.getByLabel('Source').selectOption('order');
  await map.getByLabel('Cart field').selectOption('cart_url');
  await step.getByLabel('Minutes after the cart').fill('60');
  await card.getByLabel('Send cart reminders').check();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // 2. Two checkouts (one without a phone), then the first customer orders.
  const phone = `+97155${suffix}9`;
  expect((await page.request.post(`${MOCK_META}/mock/shopify/${shop}/checkout`, { data: { phone, value: '249.00' } })).status()).toBe(200);
  expect((await page.request.post(`${MOCK_META}/mock/shopify/${shop}/checkout`, { data: { value: '99.00' } })).status()).toBe(200);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('store-cart-row')).toHaveCount(2, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('store-cart-row').filter({ hasText: 'Open' })).toHaveCount(1);
  await expect(page.getByTestId('store-cart-row').filter({ hasText: 'No WhatsApp number' })).toHaveCount(1);

  expect((await page.request.post(`${MOCK_META}/mock/shopify/${shop}/order`, { data: { phone } })).status()).toBe(200);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('store-cart-row').filter({ hasText: 'The customer ordered' })).toHaveCount(1, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('cart-results')).toContainText('2 carts');

  expect((await page.request.post(`/api/stores/${storeId}/disconnect`, { headers: await csrfHeaders(page) })).status()).toBe(200);
});
