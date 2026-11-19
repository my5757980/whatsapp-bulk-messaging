import { expect, test, type Page } from '@playwright/test';

// T184: quickstart US7 row - create a key, send one template through the public API (twice with
// the same Idempotency-Key), look up its status, and see an opted-out number refused.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US7: public API send, idempotency, status and opt-out refusal', async ({ page, playwright, baseURL }) => {
  const suffix = Date.now().toString().slice(-6);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);

  // A number and templates in mock-meta, then a key from the settings page.
  const number = await (await page.request.post('/api/numbers', { headers, data: { label: `API ${suffix}`, wabaId: `MOCK_WABA_A${suffix}`, phoneNumberId: `70${suffix}`, accessToken: 'mock-token' } })).json();
  await page.request.post('/api/templates/sync', { headers });
  await page.goto('/settings/api-keys');
  await page.getByRole('button', { name: 'Create API key' }).click();
  await page.getByLabel('Name').fill(`E2E ${suffix}`);
  await page.getByRole('button', { name: 'Create key' }).click();
  const secret = await page.getByRole('textbox', { name: 'API key', exact: true }).inputValue();
  expect(secret).toMatch(/^wbk_[A-Za-z0-9]{32}$/);
  await page.getByRole('button', { name: 'I have stored it' }).click();

  // The calling system uses only the key (a separate request context without the session cookie).
  const client = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${secret}` } });
  const body = { numberId: number.id, to: '+971501239999', template: { name: 'order_confirmation', language: 'en_US' }, params: { 'BODY.1': 'Sara', 'BODY.2': '#E2E' } };
  const first = await client.post('/api/v1/messages', { data: body, headers: { 'idempotency-key': `e2e-${suffix}` } });
  const second = await client.post('/api/v1/messages', { data: body, headers: { 'idempotency-key': `e2e-${suffix}` } });
  expect(first.status()).toBe(202);
  expect(second.status()).toBe(200);
  const accepted = await first.json();
  expect((await second.json()).id).toBe(accepted.id);

  await expect(async () => {
    const status = await (await client.get(`/api/v1/messages/${accepted.id}`)).json();
    expect(['SENT', 'DELIVERED', 'READ']).toContain(status.status);
  }).toPass({ timeout: 60_000 });

  // A contact who replied STOP is refused with a clear reason.
  await page.request.post('/api/contacts', { headers, data: { phone: `+97150555${suffix.slice(-4)}`, consentStatus: 'OPTED_OUT' } });
  const refused = await client.post('/api/v1/messages', { data: { ...body, to: `+97150555${suffix.slice(-4)}` } });
  expect(refused.status()).toBe(422);
  expect((await refused.json()).code).toBe('CONTACT_OPTED_OUT');

  await page.goto('/api-messages');
  await expect(page.getByTestId('api-message-row').first()).toBeVisible();
  await client.dispose();
});
