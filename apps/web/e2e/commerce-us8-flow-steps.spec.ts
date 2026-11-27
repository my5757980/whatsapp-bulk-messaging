import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { MOCK_META, csrfHeaders, signInAsAdmin } from './growth-helpers';
import { ensureStripeConnected } from './payments-helpers';

// T088 (feature 008, quickstart US8 row): a flow sends a product list, charges the cart total, then sends
// a form whose answer it uses. It runs for a test number: a CLI cart, Mark paid (test) in the test panel,
// and a CLI form answer with the token from /mock/sent.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_CATALOG_ID = '900000000000001';

async function ensureCatalog(page: Page): Promise<void> {
  const state = (await (await page.request.get('/api/catalog/connection')).json()) as { connection: unknown };
  if (!state.connection) expect((await page.request.post('/api/catalog/connection', { headers: await csrfHeaders(page), data: { catalogId: MOCK_CATALOG_ID } })).status()).toBe(201);
  await expect.poll(async () => ((await (await page.request.get('/api/catalog/connection')).json()) as { connection: { productCount: number } | null }).connection?.productCount ?? 0, { timeout: 90_000 }).toBe(40);
}

test('US8: product list, cart-total payment and a form in one flow, run from the test panel', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const phoneNumberId = `85${suffix}`;
  const tester = `+97155${suffix}8`;
  const keyword = `buy${suffix.slice(-4)}`;
  await signInAsAdmin(page);
  await ensureStripeConnected(page);
  const headers = await csrfHeaders(page);
  expect((await page.request.post('/api/numbers', { headers, data: { label: `Flow shop ${suffix}`, wabaId: `MOCK_WABA_S${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status()).toBe(201);
  await ensureCatalog(page);

  // A published form for the last step.
  const form = await page.request.post('/api/forms', { headers, data: { name: `Delivery ${suffix}`, category: 'OTHER' } });
  const formId = ((await form.json()) as { id: string }).id;
  expect(
    (
      await page.request.put(`/api/forms/${formId}`, {
        headers,
        data: { name: `Delivery ${suffix}`, category: 'OTHER', draft: { screens: [{ title: 'Delivery', button: 'Submit', fields: [{ key: 'address', type: 'shortText', label: 'Address', required: true }] }] }, mapping: [], tagIds: [] },
      })
    ).status(),
  ).toBe(200);
  expect((await page.request.post(`/api/forms/${formId}/publish`, { headers })).status()).toBe(201);

  // The flow: Send products → Request payment (cart total) → Send form → a message with the answer.
  const created = await page.request.post('/api/flows', { headers, data: { name: `Shop by chat ${suffix}` } });
  const flowId = ((await created.json()) as { id: string }).id;
  const graph = {
    version: 1,
    start: 'list',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [keyword], canInterrupt: false }],
    steps: [
      { id: 'list', type: 'product', header: 'Our picks', body: 'Add to your cart and send it', sections: [{ title: '', retailerIds: ['shp-101', 'shp-102'] }], timeoutMinutes: 60, next: 'pay', onTimeout: null },
      { id: 'pay', type: 'payment', amount: { source: 'cartTotal' }, description: 'Your order', expiryMinutes: 120, next: 'ask', onNotPaid: null },
      { id: 'ask', type: 'form', formId, body: 'Where should we deliver?', cta: 'Add address', answerPrefix: 'delivery', timeoutMinutes: 60, next: 'done', onTimeout: null },
      { id: 'done', type: 'message', text: `On its way to {answer:delivery_address} ${suffix}` },
    ],
  };
  expect((await page.request.put(`/api/flows/${flowId}/draft`, { headers, data: { graph, draftRevision: 0 } })).status()).toBe(200);
  const published = await page.request.post(`/api/flows/${flowId}/publish`, { headers });
  expect(published.status(), await published.text()).toBe(200);
  expect((await page.request.patch(`/api/flows/${flowId}`, { headers, data: { testNumbers: [tester] } })).status()).toBe(200);

  const inbound = (args: string) => execSync(`npm run mock:inbound -- --from ${tester} --name "Tester" --phone-number-id ${phoneNumberId} ${args}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  inbound(`--text "${keyword}"`);
  await expect
    .poll(async () => {
      const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; interactive?: { type?: string } }> };
      return sent.messages.filter((m) => m.phoneNumberId === phoneNumberId).map((m) => m.interactive?.type);
    }, { timeout: 30_000 })
    .toContain('product_list');

  // The cart goes to the flow; the test request is driven from the test panel.
  inbound('--order "shp-101:1,shp-102:1"');
  await page.goto(`/flows/${flowId}`);
  await expect(page.getByText('Test payments waiting')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Mark paid (test)' }).click();
  await expect(page.getByText(/Marked paid/)).toBeVisible();

  // The form arrives; the customer answers it.
  let token = '';
  await expect(async () => {
    const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; interactive?: { type?: string; action?: { parameters?: { flow_token?: string } } } }> };
    token = sent.messages.filter((m) => m.phoneNumberId === phoneNumberId && m.interactive?.type === 'flow').at(-1)?.interactive?.action?.parameters?.flow_token ?? '';
    expect(token).toMatch(/^wf1\./);
  }).toPass({ timeout: 30_000 });
  inbound(`--form-reply ${token} --answers "{\\"address\\":\\"Marina Walk 5\\"}"`);
  await expect
    .poll(async () => {
      const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; text?: string }> };
      return sent.messages.filter((m) => m.phoneNumberId === phoneNumberId).map((m) => m.text);
    }, { timeout: 30_000 })
    .toContain(`On its way to Marina Walk 5 ${suffix}`);
});
