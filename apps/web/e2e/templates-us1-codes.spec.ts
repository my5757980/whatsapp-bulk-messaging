import { expect, test, type Page } from '@playwright/test';
import { connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T023 (feature 009, quickstart US1 row): a code template built in the editor and approved on mock-meta,
// the code settings, a key with "Send one-time codes", a code sent through the API with the code twice in
// the payload and never shown back, and the per-phone limit.

async function otpKey(page: Page): Promise<string> {
  const headers = await csrfHeaders(page);
  const created = await page.request.post('/api/api-keys', { headers, data: { name: `Codes e2e ${Date.now()}`, rateLimitPerMinute: 600 } });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { id: string; secret: string };
  expect((await page.request.put(`/api/api-keys/${body.id}/scopes`, { headers, data: { scopes: ['otp.send'] } })).status()).toBe(200);
  return body.secret;
}

test('US1: a code template, the settings, a code through the API and the per-phone limit', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const name = `login_code_${suffix}`;
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Codes', suffix);

  // 1. The editor: the one-time code type with Meta's fixed wording.
  await page.goto('/templates/new');
  await page.getByLabel('Type').selectOption('AUTHENTICATION');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(name);
  await expect(page.getByTestId('code-options')).toContainText('is your verification code');
  await page.getByLabel('Code valid for (minutes, optional)').fill('10');
  await page.getByLabel('Time-to-live in minutes (optional)').fill('5');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  const templateId = page.url().split('/').pop()!;
  await expect
    .poll(async () => ((await (await page.request.get(`/api/templates/${templateId}`)).json()) as { status: string }).status, { timeout: 60_000 })
    .toBe('APPROVED');
  const template = (await (await page.request.get(`/api/templates/${templateId}`)).json()) as { kind: string; ttlSeconds: number; ttlAppliedBy: string };
  expect(template).toMatchObject({ kind: 'AUTHENTICATION', ttlSeconds: 300, ttlAppliedBy: 'META' });

  // 2. The settings: the default template, and a limit of 2 codes per phone.
  await page.goto('/settings/one-time-codes');
  await page.getByLabel('Code template').selectOption(templateId);
  await page.getByLabel('Codes per phone number').fill('2');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('One-time code settings saved')).toBeVisible();

  // 3. A code through the API: sent with the code twice, never shown back.
  const key = await otpKey(page);
  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  const numberId = numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id;
  const phone = `+97150${suffix}3`;
  const send = (code: string) => page.request.post('/api/v1/otp', { headers: { authorization: `Bearer ${key}` }, data: { to: phone, code, numberId } });
  const first = await send('482913');
  expect(first.status(), await first.text()).toBe(202);
  const { id } = (await first.json()) as { id: string };
  await expect
    .poll(async () => (await sentMessages(page, number.phoneNumberId, name)).length, { timeout: 30_000 })
    .toBeGreaterThan(0);
  const sent = (await sentMessages(page, number.phoneNumberId, name)).at(-1)!;
  expect(JSON.stringify(sent.components).match(/482913/g)).toHaveLength(2);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/v1/otp/${id}`, { headers: { authorization: `Bearer ${key}` } })).json()) as { status: string }).status, { timeout: 30_000 })
    .toMatch(/sent|delivered|read/);
  const status = await (await page.request.get(`/api/v1/otp/${id}`, { headers: { authorization: `Bearer ${key}` } })).text();
  expect(status).not.toContain('482913');

  // 4. The per-phone limit.
  expect((await send('111111')).status()).toBe(202);
  const third = await send('222222');
  expect(third.status()).toBe(429);
  expect(((await third.json()) as { code: string }).code).toBe('TOO_MANY_CODES');
});
