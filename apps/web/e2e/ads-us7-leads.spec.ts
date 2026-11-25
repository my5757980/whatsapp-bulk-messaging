import { expect, test } from '@playwright/test';
import { ensureAdsConnected } from './ads-helpers';
import { MOCK_META, connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

interface Sent {
  phoneNumberId: string;
  to: string;
  template?: string;
}

// T058 (feature 007, quickstart US7 row): on mock-meta, a lead form "Spring offer" with a tag and a
// welcome template; two mock leads arrive as signed page webhooks; both become tagged contacts, only the
// one who ticked the WhatsApp box is opted in, and only that one gets the welcome template, once.
test('US7: leads from a lead form become tagged contacts, with consent and one welcome message', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = String(Date.now()).slice(-6);
  const tagName = `spring-${suffix}`;
  const formName = `Spring offer ${suffix}`;
  const phones = { yes: `+97155${suffix}1`, no: `+97155${suffix}2` };
  await signInAsAdmin(page);
  await ensureAdsConnected(page);
  const number = await connectNumber(page, 'Ads US7', suffix);
  const headers = await csrfHeaders(page);
  expect((await page.request.post('/api/templates/sync', { headers })).ok()).toBe(true);
  const templates = (await (await page.request.get(`/api/templates?status=APPROVED&wabaId=${number.wabaId}`)).json()) as Array<{ id: string; name: string }>;
  const welcome = templates.find((t) => t.name === 'order_confirmation')!;
  expect((await page.request.post('/api/tags', { data: { name: tagName }, headers })).ok()).toBe(true);

  // 1. The form, with the tag and the welcome template (its second variable is fixed text).
  await page.goto('/ads/lead-forms');
  await page.getByLabel('Form name').fill(formName);
  await page.getByLabel('Privacy policy (https)').fill('https://example.com/privacy');
  await page.getByLabel('Tag for leads').selectOption({ label: tagName });
  await page.getByLabel(/Welcome template/).selectOption(welcome.id);
  await page.getByLabel('BODY.2').selectOption('__fixed');
  await page.getByLabel('Text').fill('SPRING');
  await page.getByRole('button', { name: 'Make lead form' }).click();
  await expect(page.getByRole('link', { name: formName })).toBeVisible();
  const form = ((await (await page.request.get('/api/ads/lead-forms')).json()) as Array<{ id: string; name: string; metaFormId: string }>).find((f) => f.name === formName)!;

  // 2. Two leads: one ticks the WhatsApp box, one does not.
  for (const [phone, consent] of [
    [phones.yes, true],
    [phones.no, false],
  ] as const) {
    const res = await page.request.post(`${MOCK_META}/mock/ads/lead`, { data: { formId: form.metaFormId, answers: { full_name: `Lead ${phone.slice(-1)}`, phone_number: phone }, consent } });
    expect(res.ok()).toBe(true);
  }
  await page.goto(`/ads/lead-forms/${form.id}`);
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('lead-row')).toHaveCount(2, { timeout: 3_000 });
  }).toPass({ timeout: 60_000 });

  // 3. Both are tagged contacts; only the consenting one is opted in.
  const contact = async (phone: string) =>
    ((await (await page.request.get(`/api/contacts?q=${encodeURIComponent(phone)}`)).json()) as { items: Array<{ phone: string; tags: string[]; consentStatus: string }> }).items.find((c) => c.phone === phone)!;
  expect(await contact(phones.yes)).toMatchObject({ consentStatus: 'OPTED_IN' });
  expect((await contact(phones.yes)).tags).toContain(tagName);
  expect((await contact(phones.no)).consentStatus).not.toBe('OPTED_IN');
  expect((await contact(phones.no)).tags).toContain(tagName);

  // 4. Exactly one welcome message, to the consenting lead.
  const sentTo = async (phone: string) =>
    ((await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Sent[] }).messages.filter((m) => m.phoneNumberId === number.phoneNumberId && m.to === phone.slice(1)).length;
  await expect.poll(() => sentTo(phones.yes), { timeout: 60_000 }).toBe(1);
  expect(await sentTo(phones.no)).toBe(0);
});
