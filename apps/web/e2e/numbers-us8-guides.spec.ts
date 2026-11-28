import { expect, test } from '@playwright/test';
// Read from the shared source (e2e does not build the workspace package).
import { NUMBER_GUIDES } from '../../../packages/shared/src/settings/number-guides';
import { connectNumber, signInAsAdmin } from './growth-helpers';

// T081 (feature 010, quickstart US8 row): both guides from the numbers page, every step and warning from the
// shared data, and the link to the number removal with its typed confirmation.

test('US8: guides for moving a number in and out', async ({ page }) => {
  test.setTimeout(120_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Guides', suffix);

  for (const guide of NUMBER_GUIDES) {
    await page.goto('/settings/numbers');
    await page.getByRole('link', { name: guide.id === 'move-here' ? 'Move a number here' : 'Move a number back to the app' }).click();
    await expect(page.getByRole('heading', { name: guide.title })).toBeVisible();
    await expect(page.getByTestId('guide-step')).toHaveCount(guide.steps.length);
    for (const step of guide.steps) await expect(page.getByTestId('guide-step').filter({ hasText: step.title })).toContainText(step.body);
    await expect(page.getByTestId('guide-warning')).toHaveCount(guide.steps.filter((s) => s.warning).length);
    for (const link of guide.links) await expect(page.getByRole('link', { name: link.label })).toHaveAttribute('href', link.url);
    await expect(page.getByText(`Checked against Meta's pages on ${guide.checkedAt}.`)).toBeVisible();
  }

  // The "move back" guide leads to the removal, which asks for the number to be typed.
  await page.getByRole('link', { name: 'Open WhatsApp numbers to remove it' }).click();
  await expect(page).toHaveURL(/\/settings\/numbers$/);
  await page.getByRole('row', { name: new RegExp(number.label) }).getByRole('button', { name: 'Disconnect' }).click();
  const dialog = page.getByRole('dialog');
  const confirm = dialog.getByRole('button', { name: 'Disconnect' });
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill('+1 555 000 0000');
  await expect(confirm).toBeDisabled();
  await dialog.getByLabel(/to confirm/).fill('+1 555 010 0000');
  await confirm.click();
  await expect(page.getByText(`${number.label} disconnected`)).toBeVisible();
});
