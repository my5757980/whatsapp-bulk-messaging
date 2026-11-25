import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T037 (feature 006, quickstart US3 row): build "Order feedback" in the dashboard and set it live,
// trigger it three times (a new phone, an existing contact, a repeated idempotency key), pause it
// and trigger again, then read the results and the new contact's tag.
test('US3: an API campaign from building to results', async ({ page, playwright, baseURL }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const apiName = `order-feedback-${suffix}`;
  const templateName = `order_feedback_${suffix}`;

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Feedback', suffix);

  // An approved utility template with two variables (mock-meta approves it).
  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(templateName);
  await page.getByLabel('Category').selectOption('UTILITY');
  await page.getByLabel('Message text').fill('Order {{1}}: how did you like {{2}}?');
  await page.getByLabel('Sample for {{1}}').fill('A-1001');
  await page.getByLabel('Sample for {{2}}').fill('Shoes');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  // 1. Build it and set it live.
  await page.goto('/campaigns');
  await page.getByRole('link', { name: 'API campaigns' }).click();
  await expect(page).toHaveURL(/\/campaigns\/api$/);
  await page.getByRole('button', { name: 'New API campaign' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Campaign name').fill(`Order feedback ${suffix}`);
  await expect(dialog.getByLabel('API name')).toHaveValue(apiName);
  await dialog.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await dialog.getByLabel('Approved template').selectOption({ label: `${templateName} · en_US · Utility` });
  await dialog.getByRole('button', { name: 'Create draft' }).click();
  await expect(page).toHaveURL(/\/campaigns\/api\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('api-campaign-status')).toHaveText('Draft');

  for (const [variable, value] of [
    ['BODY.1', 'order'],
    ['BODY.2', 'product'],
  ] as const) {
    const row = page.getByTestId(`mapping-${variable}`);
    await row.getByLabel('Source').selectOption('value');
    await row.getByLabel('Value name').fill(value);
  }
  await page.getByLabel('Tags to add').fill('feedback');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Changes saved')).toBeVisible();
  await page.getByRole('button', { name: 'Set live' }).click();
  await expect(page.getByTestId('api-campaign-status')).toHaveText('Live');
  await expect(page.getByTestId('call-example')).toContainText(`/api/v1/api-campaigns/${apiName}/messages`);
  await expect(page.getByTestId('call-example')).toContainText('"product"');

  // 2. The shop triggers it with a key allowed to trigger campaigns.
  const key = await (await page.request.post('/api/api-keys', { data: { name: `Shop ${suffix}` }, headers: await csrfHeaders(page) })).json();
  expect((await page.request.put(`/api/api-keys/${key.id}/scopes`, { data: { scopes: ['campaigns.trigger'] }, headers: await csrfHeaders(page) })).status()).toBe(200);
  const shop = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  const path = `/api/v1/api-campaigns/${apiName}/messages`;
  const newPhone = `+97155${suffix}2`;
  const existingPhone = `+97156${suffix}3`;
  expect((await page.request.post('/api/contacts', { data: { phone: existingPhone, name: 'Omar' }, headers: await csrfHeaders(page) })).status()).toBe(201);

  const call = { phone: newPhone, name: 'Layla', values: { order: 'A-1001', product: 'Shoes' } };
  const first = await shop.post(path, { data: call, headers: { 'idempotency-key': `feedback-${suffix}` } });
  expect(first.status()).toBe(202);
  expect((await shop.post(path, { data: { phone: existingPhone, values: { order: 'A-1002', product: 'Bag' } } })).status()).toBe(202);
  const repeat = await shop.post(path, { data: call, headers: { 'idempotency-key': `feedback-${suffix}` } });
  expect(repeat.status()).toBe(202);
  expect(await repeat.json()).toEqual(await first.json());
  await expect(async () => expect(await sentMessages(page, number.phoneNumberId, templateName)).toHaveLength(2)).toPass({ timeout: 60_000 });

  // 3. Paused: the call is refused.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByTestId('api-campaign-status')).toHaveText('Paused');
  const paused = await shop.post(path, { data: { phone: newPhone, values: { order: 'A-1003', product: 'Hat' } } });
  expect(paused.status()).toBe(409);
  expect(await paused.json()).toMatchObject({ code: 'NOT_LIVE', reason: 'paused' });

  // 4. Results: 3 triggers, 2 sent and 1 not sent; the new phone is a contact tagged "feedback".
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('result-triggers')).toHaveText('3', { timeout: 2_000 });
    await expect(page.getByTestId('result-sent')).toHaveText('2', { timeout: 2_000 });
    await expect(page.getByTestId('result-notSent')).toHaveText('1', { timeout: 2_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByRole('link', { name: 'Export CSV' })).toBeVisible();
  const contacts = (await (await page.request.get(`/api/contacts?q=${encodeURIComponent(newPhone)}`)).json()) as { items: Array<{ phone: string; name: string; tags: string[] }> };
  expect(contacts.items.find((c) => c.phone === newPhone)).toMatchObject({ name: 'Layla', tags: ['feedback'] });
  await shop.dispose();
});
