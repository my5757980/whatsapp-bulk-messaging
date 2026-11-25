import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MOCK_META, PHONE_UA, PREVIEW_UA, connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T072 (feature 006, quickstart US7 row): "Shop counter" with the flow "Welcome" and a tag; the QR
// images and the poster; the short link opened twice (once as a WhatsApp preview); the pre-filled
// message from a new phone gives 1 opening, 1 chat started and 1 new contact, the flow reply and the tag.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface Sent {
  phoneNumberId: string;
  to: string;
  type?: string;
  text?: string;
}

test('US7: a chat link with a QR code starts a chat, runs its flow and tags the contact', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString().slice(-6);
  const tagName = `counter-${suffix}`;
  const welcome = `Welcome to the shop counter ${suffix}!`;

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Links', suffix);
  const headers = await csrfHeaders(page);
  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  const numberId = numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id;

  // The tag and the published flow the link uses.
  expect((await page.request.post('/api/tags', { data: { name: tagName }, headers })).ok()).toBe(true);
  const flow = (await (await page.request.post('/api/flows', { data: { name: `Welcome ${suffix}` }, headers })).json()) as { id: string };
  const graph = {
    version: 1,
    start: 'a',
    triggers: [{ id: 'kw', kind: 'KEYWORD', match: 'EXACT', phrases: [`welcome${suffix}`], canInterrupt: false }],
    steps: [{ id: 'a', type: 'message', text: welcome, next: null }],
  };
  expect((await page.request.put(`/api/flows/${flow.id}/draft`, { data: { graph, draftRevision: 0 }, headers })).status()).toBe(200);
  expect((await page.request.post(`/api/flows/${flow.id}/publish`, { headers })).status()).toBe(200);

  // 1. Create "Shop counter" from Campaigns > Chat links.
  await page.goto('/campaigns');
  await page.getByRole('link', { name: 'Chat links' }).click();
  await expect(page).toHaveURL(/\/campaigns\/chat-links$/);
  await page.getByRole('button', { name: 'New chat link' }).click();
  await page.getByLabel('Name', { exact: true }).fill(`Shop counter ${suffix}`);
  await page.getByLabel('WhatsApp number').selectOption(numberId);
  await page.getByLabel('Pre-filled message').fill(`Hi, I saw your poster at the counter ${suffix}`);
  await page.getByLabel('Flow to start (optional)').selectOption(flow.id);
  await page.getByLabel('Tag for the contact (optional)').selectOption({ label: tagName });
  await page.getByRole('button', { name: 'Create chat link' }).click();
  await expect(page).toHaveURL(/\/campaigns\/chat-links\/[0-9a-f-]{36}$/);
  const linkId = page.url().split('/').pop()!;

  // 2. The QR code as SVG and PNG, and the poster.
  await expect.poll(() => page.getByTestId('chat-link-qr').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 15_000 }).toBe(true);
  const png = await page.request.get(`/api/chat-links/${linkId}/qr?format=png&size=512`);
  expect(png.status()).toBe(200);
  expect(png.headers()['content-type']).toBe('image/png');
  const svg = await page.request.get(`/api/chat-links/${linkId}/qr?format=svg`);
  expect(await svg.text()).toContain('<svg');
  const poster = await page.context().newPage();
  await poster.goto(`/campaigns/chat-links/${linkId}/poster`);
  await expect(poster.getByTestId('chat-link-poster')).toContainText('Chat with us on WhatsApp');
  await poster.close();

  // 3. The short link opened twice: a WhatsApp preview (not counted), then a phone.
  const link = (await (await page.request.get(`/api/chat-links/${linkId}`)).json()) as { shortUrl: string; whatsappUrl: string };
  expect((await page.request.get(link.shortUrl, { headers: { 'User-Agent': PREVIEW_UA }, maxRedirects: 0 })).status()).toBe(302);
  const opened = await page.request.get(link.shortUrl, { headers: { 'User-Agent': PHONE_UA }, maxRedirects: 0 });
  expect(opened.status()).toBe(302);
  expect(opened.headers().location).toBe(link.whatsappUrl);
  const prefilled = new URL(link.whatsappUrl).searchParams.get('text')!;
  expect(prefilled).toMatch(/ \(ref [A-Z0-9]{6}\)$/);

  // 4. A new phone sends the pre-filled message: the flow answers.
  const customer = `+97156${suffix}7`;
  execSync(`npm run mock:inbound -- --from ${customer} --name "Mona" --phone-number-id ${number.phoneNumberId} --text "${prefilled}"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await expect
    .poll(
      async () => {
        const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Sent[] };
        return sent.messages.some((m) => m.phoneNumberId === number.phoneNumberId && m.to === customer.slice(1) && m.text === welcome);
      },
      { timeout: 60_000 },
    )
    .toBe(true);

  // 5. The results, the contact list and the tag.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('chat-link-chatsStarted')).toHaveText('1', { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });
  await expect(page.getByTestId('chat-link-opens')).toHaveText('1');
  await expect(page.getByTestId('chat-link-newContacts')).toHaveText('1');
  await expect(page.getByTestId('chat-link-contact')).toHaveCount(1);
  const contacts = (await (await page.request.get(`/api/contacts?q=${encodeURIComponent(customer)}`)).json()) as { items: Array<{ phone: string; tags: string[] }> };
  expect(contacts.items.find((c) => c.phone === customer)?.tags).toContain(tagName);

  // 6. Turned off, the link sends no one on.
  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeVisible();
  const off = await page.request.get(link.shortUrl, { headers: { 'User-Agent': PHONE_UA }, maxRedirects: 0 });
  expect(off.status()).toBe(404);
  expect(await off.text()).toContain('no longer in use');
});
