import { expect, test } from '@playwright/test';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';

// T023 (feature 010, quickstart US1 row): build a segment with live counts, save it, filter contacts by it,
// and see a rule marked broken after its tag is deleted. Campaign and drip use are covered by the
// campaign-segment-audience and drip-segment-enrol integration tests.

test('US1: segments with live counts, saved and used as a contact filter', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const headers = await csrfHeaders(page);
  const group = `seg-e2e-${suffix}`;
  const extra = `seg-extra-${suffix}`;
  for (const name of [group, extra]) expect((await page.request.post('/api/tags', { headers, data: { name } })).status()).toBe(201);
  for (const [i, consent] of (['OPTED_IN', 'OPTED_IN', 'OPTED_OUT'] as const).entries()) {
    const res = await page.request.post('/api/contacts', {
      headers,
      data: { phone: `+97155${suffix}${i}`, name: `Segment person ${suffix}-${i}`, tags: i === 0 ? [group, extra] : [group], consentStatus: consent, ...(consent === 'OPTED_IN' ? { consentSourceNote: 'Signed up at the e2e desk' } : {}) },
    });
    expect(res.status(), await res.text()).toBe(201);
  }

  // 1. The editor: a tag rule, then opted-in only; the counts follow.
  await page.goto('/contacts/segments/new');
  await page.getByLabel('Name').fill(`E2E segment ${suffix}`);
  await page.getByLabel('Rule 1.1 kind').selectOption('tag');
  await page.getByLabel('Rule 1.1 tag').selectOption(group);
  await expect(page.getByTestId('segment-count')).toHaveText('3', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Add rule' }).click();
  await expect(page.getByTestId('segment-count')).toHaveText('2', { timeout: 15_000 });
  await expect(page.getByTestId('segment-counts')).toContainText('2 can get marketing');
  await page.getByRole('button', { name: 'Save segment' }).click();
  await expect(page).toHaveURL(/\/contacts\/segments\/[0-9a-f-]{36}$/);
  const segmentUrl = page.url();

  // 2. The contact list filtered by the segment.
  await page.goto('/contacts');
  await page.getByLabel('Segment').selectOption({ label: `E2E segment ${suffix}` });
  await expect(page.getByTestId('contact-row')).toHaveCount(2);
  await expect(page.getByTestId('lead-source').first()).toContainText('Added by hand');

  // 3. A rule broken by a deleted tag shows on the segment.
  const extraSegment = await page.request.post('/api/segments', {
    headers,
    data: { name: `E2E extra ${suffix}`, rules: { groups: [{ match: 'all', rules: [{ kind: 'tag', tag: extra, has: true }] }] } },
  });
  expect(extraSegment.status()).toBe(201);
  const tags = (await (await page.request.get('/api/tags')).json()) as Array<{ id: string; name: string }>;
  expect((await page.request.delete(`/api/tags/${tags.find((t) => t.name === extra)!.id}`, { headers })).status()).toBe(204);
  await page.goto(`/contacts/segments/${(await extraSegment.json()).id}`);
  await expect(page.getByText('This rule names a tag that was deleted.')).toBeVisible();
  await page.goto('/contacts/segments');
  await expect(page.getByTestId('segment-row').filter({ hasText: `E2E extra ${suffix}` })).toContainText('Needs a fix');
  await page.goto(segmentUrl);
  await expect(page.getByTestId('segment-count')).toHaveText('2', { timeout: 15_000 });
});
