import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T058 (feature 010, quickstart US5 row): a birthday automation for the current minute, contacts seeded through
// the API, the sends in mock-meta, and the results and recipients pages.

/** The company day and HH:mm now. */
function companyNow(timeZone: string): { date: string; time: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(new Date())
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

test('US5: a birthday automation sends once to contacts due today, with results and recipients', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const attributeKey = `birthday_${suffix}`;
  await signInAsAdmin(page);
  const headers = await csrfHeaders(page);
  const number = await connectNumber(page, 'Dates', suffix);
  await page.goto('/templates');
  await page.getByRole('button', { name: /Sync from Meta/ }).click();
  await expect(page.getByText(/Templates synced/)).toBeVisible({ timeout: 90_000 });

  expect((await page.request.post('/api/attributes', { headers, data: { key: attributeKey, label: `Birthday ${suffix}`, type: 'DATE' } })).status()).toBe(201);
  const { defaultTimezone } = (await (await page.request.get('/api/settings')).json()) as { defaultTimezone: string };
  const now = companyNow(defaultTimezone);
  const phones = [`+97155${suffix}1`, `+97155${suffix}2`];
  for (const [i, phone] of phones.entries()) {
    const res = await page.request.post('/api/contacts', { headers, data: { phone, name: `Birthday person ${i + 1}`, attributes: { [attributeKey]: `199${i}-${now.date.slice(5)}` } } });
    expect(res.status(), await res.text()).toBe(201);
  }

  await page.goto('/automations/new');
  await page.getByLabel('Name').fill(`Birthdays ${suffix}`);
  await page.getByLabel('Date attribute').selectOption(attributeKey);
  await page.getByLabel('Repeat').selectOption('YEARLY');
  await page.getByLabel('Send time (company time zone)').fill(now.time);
  await page.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: 'order_confirmation · en_US · Utility' });
  const body2 = page.getByTestId('automation-variable-BODY.2');
  await body2.getByLabel('BODY.2 source').selectOption('static');
  await body2.getByLabel('BODY.2 value').fill('#BDAY');
  await expect(page.getByTestId('due-preview')).toContainText(`${now.date}: 2`);
  await page.getByRole('button', { name: 'Create automation' }).click();
  await expect(page).toHaveURL(/\/automations\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('automation-status')).toHaveText('Off');
  await page.getByRole('button', { name: 'Switch on' }).click();
  await expect(page.getByTestId('automation-status')).toHaveText('On');

  // The minute tick sends one message to each contact due today.
  await expect
    .poll(async () => (await sentMessages(page, number.phoneNumberId, 'order_confirmation')).map((m) => `+${m.to}`).sort(), { timeout: 150_000, intervals: [5_000] })
    .toEqual(phones);

  await expect
    .poll(
      async () => {
        await page.reload();
        return page.getByTestId('results-day').filter({ hasText: now.date }).getByTestId('results-sent').textContent();
      },
      { timeout: 60_000, intervals: [5_000] },
    )
    .toBe('2');
  await page.getByRole('button', { name: now.date }).click();
  await expect(page.getByTestId('recipient-row')).toHaveCount(2);
  await expect(page.getByTestId('recipient-row').first()).toContainText('Sent');

  // Switch it off again; nothing more goes out today anyway.
  await page.getByRole('button', { name: 'Switch off' }).click();
  await expect(page.getByTestId('automation-status')).toHaveText('Off');
  expect(await sentMessages(page, number.phoneNumberId, 'order_confirmation')).toHaveLength(2);
});
