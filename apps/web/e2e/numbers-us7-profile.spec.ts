import { expect, test } from '@playwright/test';
import { MOCK_META, connectNumber, signInAsAdmin } from './growth-helpers';
import { solidPng } from './images';

// T076 (feature 010, quickstart US7 row): edit the business profile and upload a picture through mock-meta, a
// refused picture, a declined display name, and the blue tick checklist.

test('US7: business profile, picture, declined name and the blue tick checklist', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Profile', suffix);
  // The name was declined before the page first reads it (the page keeps Meta's answer for 5 minutes).
  expect((await page.request.post(`${MOCK_META}/mock/name-status`, { data: { phoneNumberId: number.phoneNumberId, nameStatus: 'DECLINED', newNameStatus: 'PENDING_REVIEW' } })).status()).toBe(200);

  await page.goto('/settings/numbers');
  await page.getByRole('row', { name: new RegExp(number.label) }).getByRole('link', { name: 'Profile' }).click();
  await expect(page).toHaveURL(/\/numbers\/[0-9a-f-]{36}\/profile$/);
  await expect(page.getByTestId('name-status')).toHaveText('Declined');
  await expect(page.getByTestId('name-declined-steps')).toContainText('WhatsApp Manager');
  await expect(page.getByText('Name change: in review')).toBeVisible();

  // Edit the profile.
  await page.getByLabel(/^About/).fill(`Sofas and beds ${suffix}`);
  await page.getByLabel('Website', { exact: true }).fill('https://acme.example');
  await page.getByLabel('Category', { exact: true }).selectOption('RETAIL');
  await page.getByRole('button', { name: 'Save profile' }).click();
  await expect(page.getByText('Profile saved on WhatsApp')).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/^About/)).toHaveValue(`Sofas and beds ${suffix}`);

  // A wide picture is refused before upload; a square one is saved.
  await page.getByLabel('New picture').setInputFiles({ name: 'banner.png', mimeType: 'image/png', buffer: solidPng(400, 200) });
  await expect(page.getByTestId('picture-issues')).toContainText('must be square');
  await page.getByLabel('New picture').setInputFiles({ name: 'logo.png', mimeType: 'image/png', buffer: solidPng(256, 256) });
  await expect(page.getByText('Picture saved on WhatsApp')).toBeVisible();
  await expect(page.getByAltText('Current profile picture')).toBeVisible();

  // Tick two checklist steps; they stay ticked.
  for (const step of ['policy', 'two-step']) {
    const box = page.getByTestId(`oba-step-${step}`).getByRole('checkbox');
    if (!(await box.isChecked())) await box.check();
    await expect(box).toBeChecked();
  }
  await page.reload();
  await expect(page.getByTestId('oba-step-policy').getByRole('checkbox')).toBeChecked();
  await expect(page.getByTestId('oba-step-two-step')).toContainText('Done');
});
