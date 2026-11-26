import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_META, connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';
import { createPayLinkTemplate, ensureStripeConnected, payMockSession, requests, sessionFor } from './payments-helpers';

// T049 (feature 008, quickstart US3 rows): payment requests without an agent. A flow's Request
// payment step run by a test number and driven with Mark paid (test); a campaign that asks three
// contacts to pay; a store order with the Pay link automation, paid through the mock Stripe page.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function textsSentTo(page: Page, phoneNumberId: string, phone: string): Promise<Array<string | undefined>> {
  const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; to: string; text?: string }> };
  return sent.messages.filter((m) => m.phoneNumberId === phoneNumberId && m.to === phone.slice(1)).map((m) => m.text);
}

test('US3: a flow payment step driven from the test panel', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString().slice(-6);
  const keyword = `book${suffix.slice(-4)}`;
  const tester = `+97154${suffix}3`;
  await signInAsAdmin(page);
  await ensureStripeConnected(page);
  const number = await connectNumber(page, 'PayFlow', suffix);

  const headers = await csrfHeaders(page);
  const created = await page.request.post('/api/flows', { headers, data: { name: `Booking fee ${suffix}` } });
  expect(created.status()).toBe(201);
  const flowId = ((await created.json()) as { id: string }).id;
  const graph = {
    version: 1,
    start: 'pay',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
    steps: [
      { id: 'pay', type: 'payment', amount: { source: 'static', minor: 4900 }, description: 'Booking fee', expiryMinutes: 60, next: 'thanks', onNotPaid: 'sorry' },
      { id: 'thanks', type: 'message', text: `Paid, see you soon ${suffix}` },
      { id: 'sorry', type: 'message', text: `The link expired ${suffix}` },
    ],
  };
  expect((await page.request.put(`/api/flows/${flowId}/draft`, { headers, data: { graph, draftRevision: 0 } })).status()).toBe(200);
  const published = await page.request.post(`/api/flows/${flowId}/publish`, { headers });
  expect(published.status(), await published.text()).toBe(200);
  expect((await page.request.patch(`/api/flows/${flowId}`, { headers, data: { testNumbers: [tester] } })).status()).toBe(200);

  execSync(`npm run mock:inbound -- --from ${tester} --name "Tester" --phone-number-id ${number.phoneNumberId} --text "${keyword}"`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await page.goto(`/flows/${flowId}`);
  await expect(page.getByText('Test payments waiting')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Mark paid (test)' }).click();
  await expect(page.getByText(/Marked paid/)).toBeVisible();
  await expect.poll(() => textsSentTo(page, number.phoneNumberId, tester), { timeout: 30_000 }).toContain(`Paid, see you soon ${suffix}`);
});

test('US3: a campaign asks three contacts to pay', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  await ensureStripeConnected(page);
  const number = await connectNumber(page, 'PayCampaign', suffix);
  const templateId = await createPayLinkTemplate(page, number.wabaId, `invoice_${suffix}`);
  const headers = await csrfHeaders(page);
  const tag = `invoices-${suffix}`;
  for (let i = 0; i < 3; i++) {
    const res = await page.request.post('/api/contacts', { headers, data: { phone: `+97155${suffix}${i}`, name: `Payer ${i + 1}`, tags: [tag] } });
    expect(res.status(), await res.text()).toBe(201);
  }
  const draft = await page.request.post('/api/campaigns', {
    headers,
    data: {
      name: `Invoices ${suffix}`,
      numberId: (await (await page.request.get('/api/numbers')).json()).find((n: { phoneNumberId: string }) => n.phoneNumberId === number.phoneNumberId).id,
      templateId,
      audienceType: 'FILTER',
      audienceFilter: { all: [{ tag }] },
      variableMapping: { 'BODY.1': { source: 'field', key: 'name' }, 'BODY.2': { source: 'payment', key: 'amount' } },
      paymentConfig: { amount: { source: 'static', minor: 5000 }, description: 'Invoice', expiryMinutes: 1440 },
    },
  });
  expect(draft.status(), await draft.text()).toBe(201);
  const campaignId = ((await draft.json()) as { id: string }).id;

  const launched = await page.request.post(`/api/campaigns/${campaignId}/launch`, { headers, data: {} });
  expect(launched.status(), await launched.text()).toBe(200);
  await expect.poll(async () => (await requests(page, `campaignId=${campaignId}`)).length, { timeout: 30_000 }).toBe(3);
  const rows = await requests(page, `campaignId=${campaignId}`);
  expect(new Set(rows.map((r) => r.payUrl)).size).toBe(3);
  expect(rows.every((r) => r.source === 'CAMPAIGN' && r.status === 'WAITING')).toBe(true);
});

test('US3: a store order with the Pay link automation shows paid', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const shop = `pay${suffix}`;
  const templateName = `order_pay_${suffix}`;
  await signInAsAdmin(page);
  await ensureStripeConnected(page);
  const number = await connectNumber(page, 'PayStore', suffix);
  await createPayLinkTemplate(page, number.wabaId, templateName);
  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  const store = await page.request.post('/api/stores', {
    headers: await csrfHeaders(page),
    data: {
      platform: 'SHOPIFY',
      baseUrl: `${MOCK_META}/shopify/${shop}`,
      numberId: numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id,
      defaultCountry: 'AE',
      customerTag: 'shopify',
      credentials: { clientId: 'e2e-client', clientSecret: `e2e-secret-${suffix}` },
    },
  });
  expect(store.status(), await store.text()).toBe(201);
  const storeId = ((await store.json()) as { id: string }).id;

  await page.goto(`/integrations/stores/${storeId}`);
  const card = page.getByTestId('automation-PAY_LINK');
  await card.getByLabel('Template').selectOption({ label: `${templateName} · en_US · Utility` });
  const first = card.getByTestId('map-PAY_LINK-BODY.1');
  await first.getByLabel('Source').selectOption('order');
  await first.getByLabel('Order field').selectOption('order_number');
  const second = card.getByTestId('map-PAY_LINK-BODY.2');
  await second.getByLabel('Source').selectOption('order');
  await second.getByLabel('Order field').selectOption('total');
  await card.getByLabel('Send this message').check();
  await card.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Saved', { exact: true })).toBeVisible();

  const phone = `+97156${suffix}7`;
  expect((await page.request.post(`${MOCK_META}/mock/shopify/${shop}/order`, { data: { phone, unpaid: true } })).status()).toBe(200);
  await expect.poll(async () => (await requests(page, 'source=STORE_ORDER')).filter((r) => r.phone === phone).length, { timeout: 60_000 }).toBe(1);
  const row = (await requests(page, 'source=STORE_ORDER')).find((r) => r.phone === phone)!;
  const session = await sessionFor(page, row.id);
  expect(session).toBeDefined();
  await payMockSession(page, session!.id);
  await expect.poll(async () => (await requests(page, 'source=STORE_ORDER')).find((r) => r.id === row.id)?.status, { timeout: 60_000 }).toBe('PAID');

  await page.reload();
  await expect(page.getByTestId('order-payment').filter({ hasText: 'Paid via link' })).toHaveCount(1, { timeout: 30_000 });
});
