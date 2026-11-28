import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';

// T035 (feature 010, quickstart US2 row): tags for all matching and for chosen contacts in the background,
// an automatic tag rule, the lead source column and the export.

test('US2: bulk tags, an automatic tag rule, lead sources and the contacts export', async ({ page }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const headers = await csrfHeaders(page);
  const group = `bulk-e2e-${suffix}`;
  const vip = `vip-e2e-${suffix}`;
  const auto = `auto-e2e-${suffix}`;
  for (const name of [group, vip, auto]) expect((await page.request.post('/api/tags', { headers, data: { name } })).status()).toBe(201);
  for (let i = 0; i < 3; i += 1) {
    const res = await page.request.post('/api/contacts', { headers, data: { phone: `+97156${suffix}${i}`, name: `Bulk person ${suffix}-${i}`, tags: [group] } });
    expect(res.status(), await res.text()).toBe(201);
  }

  // 1. Add a tag to everyone matching the tag filter, in the background.
  await page.goto('/contacts');
  await page.getByLabel('Tag', { exact: true }).selectOption(group);
  await expect(page.getByTestId('contact-row')).toHaveCount(3);
  await page.getByRole('button', { name: 'Tags for all matching…' }).click();
  await page.getByLabel('Tag', { exact: true }).last().selectOption({ label: vip });
  await page.getByRole('button', { name: 'Add tag for 3' }).click();
  await expect(page.getByTestId('bulk-progress')).toContainText('Done: 3 changed of 3.', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByTestId('contact-row').first()).toContainText(vip);

  // 2. Remove it from one chosen contact.
  await page.getByTestId('contact-row').first().getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Tags for chosen…' }).click();
  await page.getByLabel('Action').selectOption('TAG_REMOVE');
  await page.getByLabel('Tag', { exact: true }).last().selectOption({ label: vip });
  await page.getByRole('button', { name: 'Remove tag for 1' }).click();
  await expect(page.getByTestId('bulk-progress')).toContainText('Done: 1 changed of 1.', { timeout: 60_000 });
  await page.getByRole('button', { name: 'Close' }).click();

  // 3. An automatic tag for contacts added by hand.
  await page.goto('/settings/automatic-tags');
  await page.getByLabel('When').selectOption('CONTACT_CREATED');
  await page.getByLabel('Lead source').selectOption('CUSTOM');
  await page.getByLabel('Add the tag').selectOption({ label: auto });
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByTestId('auto-tag-rule').filter({ hasText: auto })).toBeVisible();
  const created = await page.request.post('/api/contacts', { headers, data: { phone: `+97156${suffix}9`, name: `Auto person ${suffix}` } });
  expect(created.status()).toBe(201);
  await expect
    .poll(async () => ((await (await page.request.get(`/api/contacts/${(await created.json()).id}`)).json()) as { tags: string[] }).tags, { timeout: 30_000 })
    .toContain(auto);

  // 4. The lead source column and the export of the filtered list.
  await page.goto('/contacts');
  await page.getByLabel('Tag', { exact: true }).selectOption(group);
  await expect(page.getByTestId('lead-source').first()).toHaveText('Added by hand');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('link', { name: 'Export CSV' }).click()]);
  const text = readFileSync((await download.path())!, 'utf8').trim().split('\n');
  expect(text[0]).toMatch(/^name,phone,tags,/);
  expect(text).toHaveLength(4);
  expect(text.slice(1).every((line) => line.includes(group))).toBe(true);
});
