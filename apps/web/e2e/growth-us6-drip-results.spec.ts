import { expect, test, type Page } from '@playwright/test';
import { connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T057 (feature 005, quickstart US6 row): a drip's results show each step's counts; selecting a count
// lists the contacts behind it, with an export.
test('US6: drip results and the contacts behind a count', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const people = [`+97158${suffix}1`, `+97158${suffix}2`];

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Results', suffix);
  await page.goto('/templates');
  await page.getByRole('button', { name: /Sync from Meta/ }).click();
  await expect(page.getByText('order_confirmation').first()).toBeVisible();

  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  const numberId = numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id;
  const template = ((await (await page.request.get('/api/templates?status=APPROVED')).json()) as Array<{ id: string; name: string; wabaId: string }>).find(
    (t) => t.name === 'order_confirmation' && t.wabaId === number.wabaId,
  )!;
  const contactIds: string[] = [];
  for (const [i, phone] of people.entries()) {
    const res = await page.request.post('/api/contacts', {
      data: { phone, name: `Result ${i + 1} ${suffix}`, consentStatus: 'OPTED_IN', consentSourceNote: 'E2E results' },
      headers: await csrfHeaders(page),
    });
    contactIds.push(((await res.json()) as { id: string }).id);
  }
  const created = await page.request.post('/api/drips', { data: { name: `E2E results ${suffix}`, numberId }, headers: await csrfHeaders(page) });
  const dripId = ((await created.json()) as { id: string }).id;
  const mapping = { 'BODY.1': { source: 'field', key: 'name' }, 'BODY.2': { source: 'static', value: '#E2E' } };
  expect(
    (
      await page.request.put(`/api/drips/${dripId}/steps`, {
        data: { steps: [{ templateId: template.id, variableMapping: mapping, waitMinutes: 0 }, { templateId: template.id, variableMapping: mapping, waitMinutes: 60 }] },
        headers: await csrfHeaders(page),
      })
    ).status(),
  ).toBe(200);
  expect((await page.request.post(`/api/drips/${dripId}/activate`, { headers: await csrfHeaders(page) })).status()).toBe(200);
  expect((await page.request.post(`/api/drips/${dripId}/enrolments`, { data: { contactIds }, headers: await csrfHeaders(page) })).status()).toBe(200);

  // The tick sends step 1; mock-meta delivers and reads within seconds.
  await expect(async () => {
    expect(await sentMessages(page, number.phoneNumberId, 'order_confirmation')).toHaveLength(2);
  }).toPass({ timeout: 90_000 });

  await page.goto(`/drips/${dripId}`);
  await page.getByRole('tab', { name: 'Results' }).click();
  const step1 = page.getByTestId('result-step-1');
  await expect(async () => {
    await page.getByRole('button', { name: 'Refresh results' }).click();
    await expect(step1.getByTestId('metric-READ')).toHaveText('2');
  }).toPass({ timeout: 45_000 });
  await expect(step1.getByTestId('metric-SENT')).toHaveText('2');

  await step1.getByTestId('metric-READ').click();
  await expect(page.getByTestId('metric-contact-row')).toHaveCount(2);
  const download = await page.request.get(`/api/drips/${dripId}/results/export?stepId=${await stepIdOf(page, dripId)}&metric=READ`);
  expect(download.ok()).toBe(true);
  expect((await download.text()).trim().split('\n')).toHaveLength(3);
});

async function stepIdOf(page: Page, dripId: string): Promise<string> {
  const drip = (await (await page.request.get(`/api/drips/${dripId}`)).json()) as { stepList: Array<{ id: string; position: number }> };
  return drip.stepList.find((s) => s.position === 1)!.id;
}
