import { expect, test } from '@playwright/test';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';

// T028 (feature 006, quickstart US2 row): a key gets the contact permissions on the API keys page,
// changes a contact through the API, and the dashboard shows the contact, its tags and its consent.
// (The journey entry by the API key is checked in integrations-contacts-api.int-spec.ts.)
test('US2: manage contacts through the API with a scoped key', async ({ page, playwright, baseURL }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString().slice(-6);
  const phone = `+97158${suffix}1`;

  await signInAsAdmin(page);

  // 1. A key, then its permissions on the API keys page.
  const created = await (await page.request.post('/api/api-keys', { data: { name: `CRM ${suffix}` }, headers: await csrfHeaders(page) })).json();
  await page.goto('/settings/api-keys');
  const row = page.getByTestId('api-key-row').filter({ hasText: `CRM ${suffix}` });
  await row.getByRole('button', { name: 'Permissions' }).click();
  await page.getByRole('checkbox', { name: /Read contacts/ }).check();
  await page.getByRole('checkbox', { name: /Create and change contacts/ }).check();
  await page.getByRole('button', { name: 'Save permissions' }).click();
  await expect(row).toContainText('Read contacts');

  // 2. The CRM calls the API with only the key.
  const crm = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${created.secret}` } });
  const upsert = await crm.post('/api/v1/contacts', { data: { phone, name: 'Layla', tags: ['crm-lead'] } });
  expect(upsert.status()).toBe(201);
  const contact = await upsert.json();
  expect((await crm.post(`/api/v1/contacts/${contact.id}/tags`, { data: { tags: ['newsletter'] } })).status()).toBe(200);

  // 3. The CRM records the opt-in with its source.
  expect((await crm.post(`/api/v1/contacts/${contact.id}/opt-in`, { data: { sourceNote: 'CRM signup form' } })).status()).toBe(200);

  // 4. The dashboard shows it, with its tags and consent.
  await page.goto(`/contacts/${contact.id}`);
  await expect(page.getByText('Layla').first()).toBeVisible();
  await expect(page.getByText('crm-lead').first()).toBeVisible();
  await expect(page.getByText('newsletter').first()).toBeVisible();
  await expect(page.getByText(/Opted in/i).first()).toBeVisible();

  // A send-only key cannot read contacts.
  const sendOnly = await (await page.request.post('/api/api-keys', { data: { name: `Send ${suffix}` }, headers: await csrfHeaders(page) })).json();
  const sender = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${sendOnly.secret}` } });
  const refused = await sender.get('/api/v1/contacts');
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('insufficient_scope');
  await crm.dispose();
  await sender.dispose();
});
