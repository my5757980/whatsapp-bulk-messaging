import { expect, type Page } from '@playwright/test';

// Shared steps for the feature 005 e2e specs: a mock number, a template with a tracked link button,
// a sent campaign that tracks it, and each recipient's code as mock-meta received it.
export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
export const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
export const LINK_BASE = process.env.PUBLIC_LINK_BASE_URL ?? 'http://localhost:4000/l';
export const PHONE_UA = 'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
export const PREVIEW_UA = 'WhatsApp/2.24.20.72 A';

export interface SentMessage {
  phoneNumberId: string;
  to: string;
  template: string;
  components?: Array<{ type: string; index?: string; parameters?: Array<{ text?: string }> }>;
}

export async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

export async function signInAsAdmin(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
}

/** A connected mock number; mock-meta accepts the token "mock-token". */
export async function connectNumber(page: Page, prefix: string, suffix: string): Promise<{ label: string; wabaId: string; phoneNumberId: string }> {
  const number = { label: `${prefix} ${suffix}`, wabaId: `MOCK_WABA_${prefix.replace(/\W/g, '')}${suffix}`, phoneNumberId: `5${prefix.length}${suffix}` };
  const res = await page.request.post('/api/numbers', { data: { ...number, accessToken: 'mock-token' }, headers: await csrfHeaders(page) });
  expect(res.status()).toBe(201);
  return number;
}

/** A marketing template with a tracked link button, approved by mock-meta. */
export async function createTrackedTemplate(page: Page, wabaId: string, name: string): Promise<void> {
  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(wabaId);
  await page.getByLabel('Template name').fill(name);
  await page.getByLabel('Category').selectOption('MARKETING');
  await page.getByLabel('Message text').fill('Hi {{1}}, our sale is on!');
  await page.getByLabel('Sample for {{1}}').fill('Sara');
  await page.getByRole('button', { name: 'Add tracked link button' }).click();
  await page.getByLabel('Button 1 text').fill('Shop now');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });
}

/** Uploads the contacts, tracks the button to `destination`, sends now and waits until it completes. Returns the campaign page URL. */
export async function sendTrackedCampaign(
  page: Page,
  args: { name: string; numberLabel: string; templateName: string; phones: string[]; destination: string },
): Promise<string> {
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(args.name);
  await page.getByLabel('Send from').selectOption({ label: `${args.numberLabel} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: `${args.templateName} · en_US · Marketing` });
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await page.getByLabel(/Recipient list/).setInputFiles({
    name: 'contacts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`name,phone\n${args.phones.map((p, i) => `Clicker ${i + 1},${p}`).join('\n')}\n`),
  });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E growth list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText(`${args.phones.length} rows processed`, { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
  const button = page.getByTestId('mapping-BUTTON.0.1');
  await expect(button.getByLabel('Source')).toHaveValue('tracked');
  await button.getByLabel('Destination address').fill(args.destination);
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByTestId('eligible-count')).toHaveText(String(args.phones.length));
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  const url = page.url();
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });
  return url;
}

/** Every send of a template on a number, as mock-meta logged it. */
export async function sentMessages(page: Page, phoneNumberId: string, templateName: string): Promise<SentMessage[]> {
  const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: SentMessage[] };
  return sent.messages.filter((m) => m.phoneNumberId === phoneNumberId && m.template === templateName);
}

/** Each recipient's tracked-link code (E.164 phone -> code) from the URL button of their message. */
export async function codesByPhone(page: Page, phoneNumberId: string, templateName: string, count: number): Promise<Map<string, string>> {
  const codes = new Map<string, string>();
  await expect(async () => {
    for (const m of await sentMessages(page, phoneNumberId, templateName)) {
      const code = m.components?.find((c) => c.type === 'button')?.parameters?.[0]?.text;
      if (code && !codes.has(`+${m.to}`)) codes.set(`+${m.to}`, code);
    }
    expect(codes.size).toBe(count);
  }).toPass({ timeout: 30_000 });
  return codes;
}

/** Opens a tracked link like a phone (or a preview fetcher) without following the redirect. */
export async function openTrackedLink(page: Page, code: string, userAgent = PHONE_UA) {
  return page.request.get(`${LINK_BASE}/${code}`, { headers: { 'User-Agent': userAgent }, maxRedirects: 0 });
}
