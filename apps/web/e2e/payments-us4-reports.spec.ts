import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';
import { STRIPE_KEY_LIVE, STRIPE_KEY_OK, connectStripe, createPayLinkTemplate, payMockSession, refundMockSession, requests, sessionFor } from './payments-helpers';

// T057 (feature 008, quickstart US4 row): a reminder in the settings; the payments page totals for
// five requests (two paid, one paid then refunded in half, two waiting) on a live-mode mock account
// (test payments are left out of totals, FR-005); the filters and the export; and a payment campaign's
// Not paid group retargeted.

async function apiKey(page: Page, scopes: string[]): Promise<string> {
  const headers = await csrfHeaders(page);
  const created = await page.request.post('/api/api-keys', { headers, data: { name: `Payments e2e ${Date.now()}`, rateLimitPerMinute: 600 } });
  expect(created.status()).toBe(201);
  const body = (await created.json()) as { id: string; secret: string };
  expect((await page.request.put(`/api/api-keys/${body.id}/scopes`, { headers, data: { scopes } })).status()).toBe(200);
  return body.secret;
}

async function ask(page: Page, key: string, phone: string, amountMinor: number): Promise<string> {
  const res = await page.request.post('/api/v1/payments', {
    headers: { authorization: `Bearer ${key}`, 'idempotency-key': `e2e-${phone}-${amountMinor}` },
    data: { phone, amountMinor, description: `Invoice ${amountMinor / 100}`, send: false },
  });
  expect(res.status(), await res.text()).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

test('US4: reminders, totals, filters, export and retargeting non-payers', async ({ page }) => {
  test.setTimeout(480_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  await connectStripe(page, STRIPE_KEY_LIVE);
  try {
    const number = await connectNumber(page, 'PayReports', suffix);
    const templateName = `pay_reminder_${suffix}`;
    await createPayLinkTemplate(page, number.wabaId, templateName);

    // 1. A reminder two hours before the link expires.
    await page.goto('/payments/settings');
    const reminders = page.getByTestId('reminders');
    await reminders.getByRole('button', { name: 'Add reminder' }).click();
    const first = page.getByTestId('reminder-1');
    await first.getByLabel('Hours before the link expires').fill('2');
    await first.getByLabel('Template').selectOption({ label: `${templateName} (en_US)` });
    await first.getByLabel('BODY.1').selectOption('field:name');
    await first.getByLabel('BODY.2').selectOption('payment:amount');
    await page.getByRole('button', { name: 'Save settings' }).click();
    await expect(page.getByText('Payment settings saved')).toBeVisible();

    // 2. Five requests: two paid, one paid then refunded in half, two waiting.
    const key = await apiKey(page, ['payments.write', 'payments.read']);
    const ids: string[] = [];
    for (const [i, amount] of [10_000, 20_000, 30_000, 5_000, 7_000].entries()) ids.push(await ask(page, key, `+97158${suffix}${i}`, amount));
    for (const id of ids.slice(0, 3)) await payMockSession(page, (await sessionFor(page, id))!.id);
    await expect.poll(async () => (await requests(page, 'status=PAID')).filter((r) => ids.includes(r.id)).length, { timeout: 60_000 }).toBe(3);
    await refundMockSession(page, (await sessionFor(page, ids[1]!))!.id, 10_000);

    await page.goto('/payments');
    await expect(page.getByTestId('tile-refunded')).toContainText('1 request', { timeout: 60_000 });
    await expect(page.getByTestId('tile-paid')).toContainText('3 requests');
    await expect(page.getByTestId('tile-waiting')).toContainText('2 requests');
    await expect(page.getByTestId('tile-requested')).toContainText('5 requests');

    // 3. Filters and the export.
    await page.getByLabel('Status').selectOption('WAITING');
    await expect(page.getByTestId('payments-table').locator('tbody tr')).toHaveCount(2);
    await page.getByLabel('Status').selectOption('');
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
    const csv = readFileSync((await download.path())!, 'utf8').trim().split('\n');
    expect(csv[0]).toMatch(/^created_at,reference,description,amount_minor/);
    expect(csv).toHaveLength(6);

    // 4. A payment campaign's Not paid group.
    const headers = await csrfHeaders(page);
    const tag = `payers-${suffix}`;
    for (let i = 0; i < 3; i++) expect((await page.request.post('/api/contacts', { headers, data: { phone: `+97159${suffix}${i}`, name: `Payer ${i + 1}`, tags: [tag] } })).status()).toBe(201);
    const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
    const templates = (await (await page.request.get('/api/templates?status=APPROVED')).json()) as Array<{ id: string; name: string }>;
    const draft = await page.request.post('/api/campaigns', {
      headers,
      data: {
        name: `Invoices to retarget ${suffix}`,
        numberId: numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id,
        templateId: templates.find((t) => t.name === templateName)!.id,
        audienceType: 'FILTER',
        audienceFilter: { all: [{ tag }] },
        variableMapping: { 'BODY.1': { source: 'field', key: 'name' }, 'BODY.2': { source: 'payment', key: 'amount' } },
        paymentConfig: { amount: { source: 'static', minor: 4_000 }, description: 'Invoice', expiryMinutes: 1440 },
      },
    });
    expect(draft.status(), await draft.text()).toBe(201);
    const campaignId = ((await draft.json()) as { id: string }).id;
    expect((await page.request.post(`/api/campaigns/${campaignId}/launch`, { headers, data: {} })).status()).toBe(200);
    await expect.poll(async () => ((await (await page.request.get(`/api/campaigns/${campaignId}`)).json()) as { state: string }).state, { timeout: 90_000 }).toBe('COMPLETED');
    const campaignRequests = await requests(page, `campaignId=${campaignId}`);
    expect(campaignRequests).toHaveLength(3);
    // The first customer pays: the link makes the session when opened.
    expect((await page.request.get(campaignRequests[0]!.payUrl, { maxRedirects: 0, headers: { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' } })).status()).toBe(302);
    await payMockSession(page, (await sessionFor(page, campaignRequests[0]!.id))!.id);
    await expect.poll(async () => (await requests(page, `campaignId=${campaignId}&status=PAID`)).length, { timeout: 60_000 }).toBe(1);

    // The dialog counts once when it opens, so wait until both unpaid messages show as delivered.
    await expect
      .poll(async () => ((await (await page.request.get(`/api/campaigns/${campaignId}/retarget-groups`)).json()) as { groups: Array<{ status: string; count: number }> }).groups.find((g) => g.status === 'NOT_PAID')?.count, { timeout: 60_000 })
      .toBe(2);
    await page.goto(`/campaigns/${campaignId}/report`);
    await page.getByRole('button', { name: 'Retarget…' }).click();
    await expect(page.getByTestId('retarget-count-NOT_PAID')).toHaveText('2', { timeout: 60_000 });
    await expect(page.getByTestId('retarget-count-PAID')).toHaveText('1');
    await page.getByTestId('retarget-NOT_PAID').getByRole('radio').check();
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(/\/campaigns\/new\?id=.+&step=2/);
    await expect(page.getByTestId('retarget-audience')).toContainText('did not pay');
  } finally {
    await connectStripe(page, STRIPE_KEY_OK);
  }
});
