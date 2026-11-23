import { expect, test, type Page } from '@playwright/test';

// T018 (feature 005, quickstart US1 row): a template with a tracked link button, a campaign that
// tracks it, clicks as a phone (one contact twice) and as WhatsApp's link preview, and the Clicked
// results. mock-meta approves the template during the next sync and logs every send with its
// parameters, so the test reads each recipient's code from GET /mock/sent.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const LINK_BASE = process.env.PUBLIC_LINK_BASE_URL ?? 'http://localhost:4000/l';
const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const PREVIEW_UA = 'WhatsApp/2.24.20.72 A';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

interface SentMessage {
  phoneNumberId: string;
  to: string;
  template: string;
  components?: Array<{ type: string; index?: string; parameters?: Array<{ text?: string }> }>;
}

test('US1: track a button link and see who clicked', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const phoneNumberId = `51${suffix}`;
  const wabaId = `MOCK_WABA_G${suffix}`;
  const label = `Clicks ${suffix}`;
  const templateName = `e2e_tracked_${suffix}`;
  const phones = [1, 2, 3].map((i) => `+97150${suffix}${i}`);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  const connect = await page.request.post('/api/numbers', {
    data: { label, wabaId, phoneNumberId, accessToken: 'mock-token' },
    headers: await csrfHeaders(page),
  });
  expect(connect.status()).toBe(201);

  // A template whose button carries each recipient's own code.
  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(wabaId);
  await page.getByLabel('Template name').fill(templateName);
  await page.getByLabel('Message text').fill('Hi {{1}}, our sale is on!');
  await page.getByLabel('Sample for {{1}}').fill('Sara');
  await page.getByRole('button', { name: 'Add tracked link button' }).click();
  await page.getByLabel('Button 1 text').fill('Shop now');
  await expect(page.getByLabel('Button 1 link')).toHaveValue(`${LINK_BASE}/{{1}}`);
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  // The campaign: upload three opted-in contacts and track the button.
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(`E2E clicks ${suffix}`);
  await page.getByLabel('Send from').selectOption({ label: `${label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: `${templateName} · en_US · Utility` });
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await page.getByLabel(/Recipient list/).setInputFiles({
    name: 'clickers.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`name,phone\n${phones.map((p, i) => `Clicker ${i + 1},${p}`).join('\n')}\n`),
  });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E clicks list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText('3 rows processed', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
  const button = page.getByTestId('mapping-BUTTON.0.1');
  await expect(button.getByLabel('Source')).toHaveValue('tracked');
  await button.getByLabel('Destination address').fill('https://shop.example/sale');
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByTestId('eligible-count')).toHaveText('3');
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  const campaignUrl = page.url();
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });

  // Each recipient's code, as mock-meta received it.
  const codes = new Map<string, string>();
  await expect(async () => {
    const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: SentMessage[] };
    for (const m of sent.messages.filter((s) => s.phoneNumberId === phoneNumberId && s.template === templateName)) {
      const code = m.components?.find((c) => c.type === 'button')?.parameters?.[0]?.text;
      if (code) codes.set(`+${m.to}`, code);
    }
    expect(codes.size).toBe(3);
  }).toPass({ timeout: 30_000 });

  const open = (phone: string, userAgent: string) => page.request.get(`${LINK_BASE}/${codes.get(phone)}`, { headers: { 'User-Agent': userAgent }, maxRedirects: 0 });
  for (const [phone, ua] of [
    [phones[0]!, PHONE_UA],
    [phones[0]!, PHONE_UA],
    [phones[1]!, PHONE_UA],
    [phones[2]!, PREVIEW_UA],
  ] as const) {
    const res = await open(phone, ua);
    expect(res.status()).toBe(302);
    expect(res.headers().location).toBe('https://shop.example/sale');
  }

  // Results: 2 clickers, 3 clicks; the preview is not counted.
  await page.goto(`${campaignUrl}/report`);
  await expect(page.getByTestId('clickers-count')).toHaveText('2', { timeout: 30_000 });
  await expect(page.getByTestId('clicks-count')).toHaveText('3');
  await page.getByRole('tab', { name: 'Clicked' }).click();
  await expect(page.getByTestId('clicker-row')).toHaveCount(2);
  await expect(page.getByTestId('clicker-row').filter({ hasText: 'Clicker 1' })).toContainText('2');
});
