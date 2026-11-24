import { expect, test } from '@playwright/test';
import { MOCK_META, connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T047 (feature 006, quickstart US4 row): connect the mock Shopify store, turn on "Order confirmed"
// with a template mapped to the order number, place an order (delivered twice) and one without a
// phone through the mock store, then see one message, the skip reason and the tagged contact.
test('US4: Shopify order confirmations from the mock store', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const shop = `e2e${suffix}`;
  const templateName = `order_confirmed_${suffix}`;

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Store', suffix);

  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(templateName);
  await page.getByLabel('Category').selectOption('UTILITY');
  await page.getByLabel('Message text').fill('Thank you! Your order {{1}} is confirmed.');
  await page.getByLabel('Sample for {{1}}').fill('#1001');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  // 1. Connect the mock store.
  await page.getByRole('link', { name: 'Integrations' }).click();
  await expect(page).toHaveURL(/\/integrations\/stores$/);
  await page.getByRole('button', { name: 'Connect a store' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Platform').selectOption('SHOPIFY');
  await dialog.getByLabel('Store address').fill(`${MOCK_META}/shopify/${shop}`);
  await dialog.getByLabel('Client ID').fill('e2e-client');
  await dialog.getByLabel('Client secret').fill(`e2e-secret-${suffix}`);
  await dialog.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await dialog.getByRole('button', { name: 'Connect store' }).click();
  await expect(page).toHaveURL(/\/integrations\/stores\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  await expect(page.getByTestId('store-status')).toHaveText('Connected');
  const storeId = page.url().split('/').pop()!;

  // 2. "Order confirmed" with the order number.
  const card = page.getByTestId('automation-ORDER_CONFIRMED');
  await card.getByLabel('Template').selectOption({ label: `${templateName} · en_US · Utility` });
  const map = card.getByTestId('map-ORDER_CONFIRMED-BODY.1');
  await map.getByLabel('Source').selectOption('order');
  await map.getByLabel('Order field').selectOption('order_number');
  await card.getByLabel('Send this message').check();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // 3. The mock store places an order (delivered twice) and one without a phone.
  const phone = `+97154${suffix}4`;
  const placed = await (await page.request.post(`${MOCK_META}/mock/shopify/${shop}/order`, { data: { phone, times: 2 } })).json();
  expect(placed.sent).toBeGreaterThanOrEqual(2);
  await page.request.post(`${MOCK_META}/mock/shopify/${shop}/order`, { data: {} });

  // One message reaches Meta for the order with a phone.
  await expect(async () => expect(await sentMessages(page, number.phoneNumberId, templateName)).toHaveLength(1)).toPass({ timeout: 60_000 });

  // 4. The orders list shows both, with the skip reason; the customer is a contact with the store tag.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('store-order-row')).toHaveCount(2, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('store-order-row').filter({ hasText: 'No WhatsApp number' })).toHaveCount(1);
  // The repeated delivery did not send a second message.
  expect(await sentMessages(page, number.phoneNumberId, templateName)).toHaveLength(1);
  const contacts = (await (await page.request.get(`/api/contacts?q=${encodeURIComponent(phone)}`)).json()) as { items: Array<{ phone: string; tags: string[] }> };
  expect(contacts.items.find((c) => c.phone === phone)?.tags).toContain('shopify');

  // Disconnect, so the five-store limit stays free for other runs.
  expect((await page.request.post(`/api/stores/${storeId}/disconnect`, { headers: await csrfHeaders(page) })).status()).toBe(200);
});
