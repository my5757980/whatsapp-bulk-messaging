import { expect, test, type Page } from '@playwright/test';
import { codesByPhone, connectNumber, createTrackedTemplate, csrfHeaders, openTrackedLink, sendTrackedCampaign, signInAsAdmin } from './growth-helpers';

// T051 (feature 005, quickstart US5 row): a drip that starts when a tag is added or when a link of a
// chosen campaign is opened. One contact gets the tag, another opens the link; both join once.
test('US5: contacts join a drip on a tag and on a click', async ({ page }) => {
  test.setTimeout(360_000);
  const suffix = Date.now().toString().slice(-6);
  const tag = `e2e-start-${suffix}`;
  const templateName = `e2e_start_${suffix}`;
  const tagged = { name: `Tagged ${suffix}`, phone: `+97156${suffix}1` };
  const clicker = `+97156${suffix}2`;

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Starts', suffix);
  await createTrackedTemplate(page, number.wabaId, templateName);
  const campaignUrl = await sendTrackedCampaign(page, { name: `E2E start source ${suffix}`, numberLabel: number.label, templateName, phones: [clicker], destination: 'https://shop.example/start' });
  const campaignName = `E2E start source ${suffix}`;

  // The tag must exist to be chosen as a starting event.
  const contact = await page.request.post('/api/contacts', {
    data: { phone: tagged.phone, name: tagged.name, consentStatus: 'OPTED_IN', consentSourceNote: 'E2E starting events' },
    headers: await csrfHeaders(page),
  });
  expect(contact.status(), await contact.text()).toBe(201);
  const contactId = ((await contact.json()) as { id: string }).id;
  expect((await page.request.post('/api/tags', { data: { name: tag }, headers: await csrfHeaders(page) })).ok()).toBe(true);

  // A drip with one step, built through the API, and its starting events set in the editor.
  const created = await page.request.post('/api/drips', { data: { name: `E2E starts ${suffix}`, numberId: await numberIdOf(page, number.phoneNumberId) }, headers: await csrfHeaders(page) });
  expect(created.status()).toBe(201);
  const dripId = ((await created.json()) as { id: string }).id;
  const template = ((await (await page.request.get('/api/templates?status=APPROVED')).json()) as Array<{ id: string; name: string }>).find((t) => t.name === templateName)!;
  const steps = await page.request.put(`/api/drips/${dripId}/steps`, {
    data: { steps: [{ templateId: template.id, variableMapping: { 'BODY.1': { source: 'field', key: 'name' } }, waitMinutes: 60, trackedLinks: [{ variableKey: 'BUTTON.0.1', destination: 'https://shop.example/drip' }] }] },
    headers: await csrfHeaders(page),
  });
  expect(steps.status(), await steps.text()).toBe(200);

  await page.goto(`/drips/${dripId}`);
  await page.getByRole('tab', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Add starting event' }).click();
  const first = page.getByTestId('trigger-1');
  await first.getByLabel('Starts when').selectOption('TAG_ADDED');
  await first.getByLabel('Tag').selectOption({ label: tag });
  await page.getByRole('button', { name: 'Add starting event' }).click();
  const second = page.getByTestId('trigger-2');
  await second.getByLabel('Starts when').selectOption('LINK_CLICKED');
  await second.getByLabel('Campaign').selectOption({ label: campaignName });
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved')).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByTestId('drip-status')).toHaveText('Active');

  // Tag one contact; the other opens their link of the campaign (twice).
  const tagged1 = await page.request.patch(`/api/contacts/${contactId}`, { data: { tags: [tag] }, headers: await csrfHeaders(page) });
  expect(tagged1.status()).toBe(200);
  const codes = await codesByPhone(page, number.phoneNumberId, templateName, 1);
  for (let i = 0; i < 2; i += 1) expect((await openTrackedLink(page, codes.get(clicker)!)).status()).toBe(302);

  // The 30-second tick turns both events into enrolments, once each.
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('enrolment-row')).toHaveCount(2);
  }).toPass({ timeout: 90_000 });
  await expect(page.getByTestId('enrolment-row').filter({ hasText: tagged.name })).toContainText('Waiting for step 1');
  expect(campaignUrl).toMatch(/\/campaigns\//);
});

/** The id of a connected number by its Meta phone number id. */
async function numberIdOf(page: Page, phoneNumberId: string): Promise<string> {
  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  return numbers.find((n) => n.phoneNumberId === phoneNumberId)!.id;
}
