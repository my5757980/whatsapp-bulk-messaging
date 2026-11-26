import { execSync } from 'node:child_process';
import { expect, test } from '@playwright/test';
import { REPO_ROOT } from './ads-helpers';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';
import { ensureStripeConnected, sessionFor, MOCK_META_URL } from './payments-helpers';

// T034 (feature 008, quickstart US2 row): a payment request in live chat. The customer opens the pay
// link and pays on the mock Stripe page: Paid shows in the chat, on the profile's Payments tab and in
// the journey. A declined card shows Failed attempt; cancelling shows Cancelled. Expiry is covered by
// the integration test with a fake clock (payments-lifecycle.int-spec.ts).
test('US2: request a payment in live chat and see it paid', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `81${suffix}`;
  const customer = `+97150${suffix.slice(-6)}2`;
  const name = `Pay ${suffix.slice(-4)}`;

  await signInAsAdmin(page);
  await ensureStripeConnected(page);
  const connect = await page.request.post('/api/numbers', {
    headers: await csrfHeaders(page),
    data: { label: `Payments ${suffix}`, wabaId: `MOCK_WABA_P${suffix}`, phoneNumberId, accessToken: 'mock-token' },
  });
  expect(connect.status()).toBe(201);
  execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --text "How do I pay for order 1042?" --phone-number-id ${phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();

  // 1. Request AED 150 for "Order 1042".
  await page.getByRole('button', { name: 'Request payment' }).click();
  const dialog = page.getByRole('dialog', { name: 'Request payment' });
  await dialog.getByLabel('Amount (AED)').fill('150');
  await dialog.getByLabel('What it is for').fill('Order 1042');
  const [made] = await Promise.all([
    page.waitForResponse((r) => r.request().method() === 'POST' && r.url().endsWith('/payment-requests')),
    dialog.getByRole('button', { name: 'Send request' }).click(),
  ]);
  expect(made.status()).toBe(201);
  const request = (await made.json()) as { id: string; payUrl: string; conversationId: string };
  const card = page.getByTestId(`payment-card-${request.id}`);
  await expect(card).toContainText('AED 150.00');
  await expect(card).toContainText('Waiting');

  // 2. The customer opens the link and pays on the mock Stripe page.
  const customerPage = await page.context().newPage();
  await customerPage.goto(request.payUrl);
  await expect(customerPage).toHaveURL(new RegExp(`^${MOCK_META_URL.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/stripe/pay/`));
  await expect(customerPage.getByTestId('amount')).toHaveText('AED 150.00');
  await customerPage.getByRole('button', { name: 'Pay' }).click();
  await expect(customerPage.getByText(/Thank you|Payment received/)).toBeVisible({ timeout: 20_000 });
  await customerPage.close();

  await expect(card).toContainText('Paid', { timeout: 60_000 });
  await page.getByRole('tab', { name: 'Payments' }).click();
  await expect(page.getByTestId('contact-payments')).toContainText('Order 1042');
  await expect(page.getByTestId('contact-payments')).toContainText('Paid');
  await page.getByRole('tab', { name: 'Journey' }).click();
  await expect(page.getByTestId('journey')).toContainText('Payment received');

  // 3. A declined card shows Failed attempt; cancelling shows Cancelled.
  const second = await page.request.post(`/api/inbox/conversations/${request.conversationId}/payment-requests`, {
    headers: await csrfHeaders(page),
    data: { amountMinor: 9900, description: 'Delivery fee' },
  });
  expect(second.status()).toBe(201);
  const secondId = ((await second.json()) as { id: string }).id;
  const session = await sessionFor(page, secondId);
  expect(session).toBeTruthy();
  const declined = await page.request.post(`${MOCK_META_URL}/mock/stripe/decline`, { data: { sessionId: session!.id } });
  expect(declined.ok()).toBe(true);
  const secondCard = page.getByTestId(`payment-card-${secondId}`);
  await expect(secondCard).toContainText('Failed attempt', { timeout: 60_000 });
  await secondCard.getByRole('button', { name: 'Cancel request' }).click();
  await page.getByRole('button', { name: 'Cancel the request' }).click();
  await expect(secondCard).toContainText('Cancelled');
});
