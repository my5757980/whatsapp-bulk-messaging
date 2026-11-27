import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';
import { ensureStripeConnected, payMockSession, requests, sessionFor } from './payments-helpers';

// T075 (feature 008, quickstart US6 row): a cart of two products from the mock catalog becomes a chat
// order card; in automatic mode the payment link arrives and paying marks the order paid; in review mode
// the agent edits the order and sends the link; a changed price shows a warning.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const MOCK_CATALOG_ID = '900000000000001';

async function ensureCatalog(page: Page): Promise<void> {
  const state = (await (await page.request.get('/api/catalog/connection')).json()) as { connection: { productCount: number } | null };
  if (!state.connection) {
    expect((await page.request.post('/api/catalog/connection', { headers: await csrfHeaders(page), data: { catalogId: MOCK_CATALOG_ID } })).status()).toBe(201);
  }
  await expect
    .poll(async () => ((await (await page.request.get('/api/catalog/connection')).json()) as { connection: { productCount: number } | null }).connection?.productCount ?? 0, { timeout: 90_000 })
    .toBe(40);
}

async function setChatOrderMode(page: Page, mode: 'AUTO' | 'REVIEW'): Promise<void> {
  const current = (await (await page.request.get('/api/payments/settings')).json()) as Record<string, unknown>;
  const body = {
    maxAmountMinor: current.maxAmountMinor,
    defaultExpiryMinutes: current.defaultExpiryMinutes,
    requestRoles: current.requestRoles,
    sessionText: current.sessionText,
    buttonText: current.buttonText,
    templateId: current.templateId ?? null,
    templateMapping: current.templateMapping ?? {},
    reminders: current.reminders ?? [],
    chatOrderMode: mode,
    chatOrderExpiryMinutes: current.chatOrderExpiryMinutes,
    chatOrderTagId: current.chatOrderTagId ?? null,
  };
  const res = await page.request.put('/api/payments/settings', { headers: await csrfHeaders(page), data: body });
  expect(res.status(), await res.text()).toBe(200);
}

test('US6: carts become chat orders, paid through a link sent automatically or after a review', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const phoneNumberId = `83${suffix}`;
  await signInAsAdmin(page);
  await ensureStripeConnected(page);
  expect((await page.request.post('/api/numbers', { headers: await csrfHeaders(page), data: { label: `Orders ${suffix}`, wabaId: `MOCK_WABA_O${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status()).toBe(201);
  await ensureCatalog(page);
  const sendCart = (from: string, name: string, extra = '') =>
    execSync(`npm run mock:inbound -- --from ${from} --name "${name}" --phone-number-id ${phoneNumberId} --order "shp-101:2,shp-102:1" ${extra}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  const openChat = async (name: string) => {
    await page.goto('/inbox');
    const row = page.getByTestId('conversation-row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.click();
  };

  // 1. Automatic mode: the link arrives at once; paying marks the order paid.
  await setChatOrderMode(page, 'AUTO');
  const auto = `+97153${suffix}1`;
  sendCart(auto, `Auto ${suffix}`, '--order-text "Deliver after 6pm"');
  await openChat(`Auto ${suffix}`);
  const card = page.locator('[data-testid^="chat-order-"]').filter({ has: page.getByTestId('chat-order-status') }).first();
  await expect(card.getByTestId('chat-order-status')).toHaveText('Payment link sent', { timeout: 30_000 });
  await expect(card).toContainText('Deliver after 6pm');
  await expect.poll(async () => (await requests(page, 'source=CHAT_ORDER')).filter((r) => r.phone === auto).length, { timeout: 30_000 }).toBe(1);
  const request = (await requests(page, 'source=CHAT_ORDER')).find((r) => r.phone === auto)!;
  await payMockSession(page, (await sessionFor(page, request.id))!.id);
  await page.reload();
  await expect(page.locator('[data-testid^="chat-order-"]').first().getByTestId('chat-order-status')).toHaveText('Paid', { timeout: 60_000 });

  // 2. Review mode: change the order, then send the link.
  await setChatOrderMode(page, 'REVIEW');
  const review = `+97153${suffix}2`;
  sendCart(review, `Review ${suffix}`);
  await openChat(`Review ${suffix}`);
  const pending = page.locator('[data-testid^="chat-order-"]').first();
  await expect(pending.getByTestId('chat-order-status')).toHaveText('Waiting for review', { timeout: 30_000 });
  const before = await pending.getByTestId('chat-order-total').textContent();
  await pending.getByRole('button', { name: 'Change items' }).click();
  await pending.getByRole('spinbutton').first().fill('1');
  await pending.getByRole('button', { name: 'Save changes' }).click();
  await expect(pending.getByTestId('chat-order-total')).not.toHaveText(before ?? '', { timeout: 15_000 });
  await pending.getByRole('button', { name: 'Send payment link' }).click();
  await expect(pending.getByTestId('chat-order-status')).toHaveText('Payment link sent', { timeout: 15_000 });

  // 3. A price that changed since the copy shows a warning (and stops automatic links).
  const changed = `+97153${suffix}3`;
  sendCart(changed, `Changed ${suffix}`, '--order-price-change');
  await openChat(`Changed ${suffix}`);
  await expect(page.locator('[data-testid^="chat-order-"]').first().getByTestId('chat-order-warnings')).toContainText('Price changed', { timeout: 30_000 });
});
