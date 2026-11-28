import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MOCK_META, connectNumber, signInAsAdmin } from './growth-helpers';

// T084 (feature 009, quickstart US8 row): the designer with its preview and snippet; the mock site shows the
// button with the product rule's greeting, Start chat reaches the chat link and an inbound message with its
// text starts a chat, both counted; the checkout page shows no button; the link and QR generator.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('US8: the website chat button on a site, its counts, and the link generator', async ({ page, context }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Widget', suffix);
  // The chat link answers with a redirect to WhatsApp. The test reads it instead of following it: the
  // request still reaches the api (so the open is counted) and the popup stops on this page.
  let whatsappUrl = '';
  await context.route(/\/l\/c\/[A-Za-z0-9]+\?/, async (route) => {
    const answer = await route.fetch({ maxRedirects: 0 });
    whatsappUrl = answer.headers()['location'] ?? '';
    await route.fulfill({ status: 200, contentType: 'text/html', body: '<p>Opening WhatsApp</p>' });
  });

  // 1. The designer: a product rule with its own greeting and message, and no button on the checkout.
  await page.goto('/website-button/new');
  await page.getByLabel('Name', { exact: true }).fill(`Shop ${suffix}`);
  const option = await page.getByLabel('Number').locator('option', { hasText: number.label }).getAttribute('value');
  await page.getByLabel('Number').selectOption(option!);
  await page.getByLabel('Brand name').fill('Lamp & Co');
  await page.getByLabel('Greeting', { exact: true }).fill('Hi! How can we help?');
  await page.getByLabel('Default message').fill('Hello, I have a question');
  await page.getByRole('button', { name: 'Add page rule' }).click();
  await page.getByLabel('Rule 1 match').selectOption('CONTAINS');
  await page.getByLabel('Rule 1 page').fill('/products');
  await page.getByLabel('Rule 1 greeting').fill('Questions about this lamp?');
  await page.getByLabel('Rule 1 message').fill('Hi, I am looking at a product');
  await page.getByRole('button', { name: 'Add page rule' }).click();
  await page.getByLabel('Rule 2 match').selectOption('CONTAINS');
  await page.getByLabel('Rule 2 page').fill('/checkout');
  await page.getByLabel('Rule 2 hide').check();
  await page.getByRole('button', { name: 'Save button' }).click();
  await expect(page).toHaveURL(/\/website-button\/[0-9a-f-]{36}$/);
  const designerUrl = page.url();
  await expect(page.frameLocator('[data-testid="widget-preview"]').locator('[data-wbm-chat-button] .open')).toContainText('Chat with us', { timeout: 15_000 });
  const snippet = (await page.getByTestId('widget-snippet').textContent()) ?? '';
  const key = /data-key="([A-Za-z0-9]{12})"/.exec(snippet)?.[1];
  expect(key).toBeTruthy();
  await page.getByRole('button', { name: 'Copy snippet' }).click();
  await expect(page.getByText('Snippet copied')).toBeVisible();

  // 2. The mock site's product page: the rule's greeting, then Start chat opens the chat link.
  const site = await context.newPage();
  await site.goto(`${MOCK_META}/mock/site/products/lamp?key=${key}`);
  const open = site.locator('[data-wbm-chat-button] .open');
  await expect(open).toBeVisible({ timeout: 15_000 });
  await open.click();
  await expect(site.locator('[data-wbm-chat-button] .greeting')).toHaveText('Questions about this lamp?');
  const [popup] = await Promise.all([context.waitForEvent('page'), site.locator('[data-wbm-chat-button] .start').click()]);
  await popup.waitForURL(/\/l\/c\/[A-Za-z0-9]+\?/, { timeout: 15_000 });
  const opened = new URL(popup.url());
  expect(opened.searchParams.get('w')).toBe(key);
  expect(opened.searchParams.get('p')).toBe('/mock/site/products/lamp');
  await expect.poll(() => whatsappUrl, { timeout: 15_000 }).toMatch(/^https:\/\/wa\.me\//);
  const text = new URL(whatsappUrl).searchParams.get('text') ?? '';
  expect(text).toMatch(/^Hi, I am looking at a product.*ref [A-Z0-9]{6}/);

  // 3. The customer sends the message: the chat counts for the product rule.
  execSync(`npm run mock:inbound -- --from +97155${suffix}7 --name "Site visitor ${suffix}" --text "${text}" --phone-number-id ${number.phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await expect(async () => {
    await page.goto(designerUrl);
    await expect(page.getByTestId('widget-stats')).toContainText('1 opens · 1 chats started', { timeout: 3_000 });
  }).toPass({ timeout: 60_000, intervals: [5_000] });
  await expect(page.getByTestId('widget-stats')).toContainText('/mock/site/products/lamp');
  await expect(page.getByTestId('widget-stats')).toContainText('Pages containing /products');

  // 4. No button on the checkout page.
  await site.goto(`${MOCK_META}/mock/site/checkout?key=${key}`);
  await expect.poll(() => site.evaluate(() => Boolean((window as unknown as { __wbmChatButton?: boolean }).__wbmChatButton)), { timeout: 15_000 }).toBe(true);
  await site.waitForLoadState('networkidle');
  await expect(site.locator('[data-wbm-chat-button]')).toHaveCount(0);

  // 5. The generator: a link and a QR code; a chat link form opens filled in from it.
  await page.goto('/tools/whatsapp-link');
  await page.getByLabel('Phone number').fill('+971 50 123 4567');
  await page.getByLabel('Message (optional)').fill('Hi there');
  await page.getByRole('button', { name: 'Make link' }).click();
  await expect(page.getByTestId('generated-url')).toHaveText(`https://wa.me/971501234567?text=${encodeURIComponent('Hi there')}`);
  await expect(page.getByTestId('generated-qr')).toBeVisible();
  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  const numberId = numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id;
  await page.goto(`/campaigns/chat-links?new=1&numberId=${numberId}&message=${encodeURIComponent('Hi there')}`);
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'New chat link' })).toBeVisible();
  await expect(dialog.getByLabel('Pre-filled message')).toHaveValue('Hi there');
});
