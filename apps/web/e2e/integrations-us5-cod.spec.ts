import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MOCK_META, connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T058 (feature 006, quickstart US5 row): COD confirmation on the mock Shopify store. Two COD orders:
// the customer confirms one and cancels the other (automatic cancel on); the store gets its tags and
// the cancel, and the results show both answers. "No answer" waits at least an hour, so the
// integration test covers it.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('US5: COD confirmation with the customer’s button taps', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const shop = `cod${suffix}`;
  const templateName = `cod_confirm_${suffix}`;

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Cod', suffix);

  // A template with two quick-reply buttons: confirm, then cancel.
  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(templateName);
  await page.getByLabel('Category').selectOption('UTILITY');
  await page.getByLabel('Message text').fill('Please confirm your cash-on-delivery order {{1}}.');
  await page.getByLabel('Sample for {{1}}').fill('#1001');
  await page.getByRole('button', { name: 'Add quick reply' }).click();
  await page.getByLabel('Button 1 text').fill('Yes, confirm');
  await page.getByRole('button', { name: 'Add quick reply' }).click();
  await page.getByLabel('Button 2 text').fill('No, cancel');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  const numberId = numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id;
  const connected = await page.request.post('/api/stores', {
    data: { platform: 'SHOPIFY', baseUrl: `${MOCK_META}/shopify/${shop}`, numberId, defaultCountry: 'AE', customerTag: 'shopify', credentials: { clientId: 'cod-client', clientSecret: `cod-secret-${suffix}` } },
    headers: await csrfHeaders(page),
  });
  expect(connected.status()).toBe(201);
  const storeId = ((await connected.json()) as { id: string }).id;

  // 1. Turn on COD with automatic cancel.
  await page.goto(`/integrations/stores/${storeId}`);
  const card = page.getByTestId('automation-COD_CONFIRMATION');
  await card.getByLabel('Template').selectOption({ label: `${templateName} · en_US · Utility` });
  const map = card.getByTestId('map-COD_CONFIRMATION-BODY.1');
  await map.getByLabel('Source').selectOption('order');
  await map.getByLabel('Order field').selectOption('order_number');
  await card.getByLabel('Cancel the order in the store when the customer cancels').check();
  await card.getByLabel('Send this message').check();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  // 2. Two COD orders.
  const phones = [`+97150${suffix}7`, `+97152${suffix}8`];
  for (const phone of phones) expect((await page.request.post(`${MOCK_META}/mock/shopify/${shop}/order`, { data: { phone, cod: true } })).status()).toBe(200);
  let payloads = new Map<string, string>();
  await expect(async () => {
    const sent = await sentMessages(page, number.phoneNumberId, templateName);
    payloads = new Map(sent.map((m) => [`+${m.to}`, m.components?.find((c) => c.type === 'button')?.parameters?.[0]?.payload ?? '']));
    expect([...payloads.values()].filter((p) => p.startsWith('cod1:'))).toHaveLength(2);
  }).toPass({ timeout: 60_000 });

  // 3. The first customer confirms, the second cancels.
  const tap = (phone: string, payload: string) =>
    execSync(`npm run mock:inbound -- --from ${phone} --phone-number-id ${number.phoneNumberId} --button-payload "${payload}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const confirm = payloads.get(phones[0]!)!;
  const cancel = payloads.get(phones[1]!)!.replace(/:Y$/, ':N');
  tap(phones[0]!, confirm);
  tap(phones[1]!, cancel);

  // 4. The store gets the tag and the cancel; the results show both answers.
  await expect(async () => {
    const state = (await (await page.request.get(`${MOCK_META}/mock/shopify/${shop}`)).json()) as { tags: Record<string, string[]>; cancelled: string[] };
    expect(Object.values(state.tags).flat()).toEqual(expect.arrayContaining(['whatsapp-cod-confirmed', 'whatsapp-cod-cancelled']));
    expect(state.cancelled).toHaveLength(1);
  }).toPass({ timeout: 60_000 });
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('cod-results')).toContainText('2 asked · 1 confirmed · 1 cancelled', { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('order-cod').filter({ hasText: 'Confirmed' })).toHaveCount(1);

  expect((await page.request.post(`/api/stores/${storeId}/disconnect`, { headers: await csrfHeaders(page) })).status()).toBe(200);
});
