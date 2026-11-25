import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T043 (feature 005, quickstart US4 row): build a 2-step drip (step 1 right away, step 2 after 10
// minutes), activate it, enrol two contacts by hand. Both get step 1 from the 30-second tick; one
// replies and leaves; the drip message shows in live chat as an automatic message from the drip.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('US4: build a drip, enrol by hand, and leave on reply', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const dripName = `E2E welcome ${suffix}`;
  const tag = `e2e-drip-${suffix}`;
  const people = [
    { name: `Drip Ann ${suffix}`, phone: `+97155${suffix}1` },
    { name: `Drip Bob ${suffix}`, phone: `+97155${suffix}2` },
  ];

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Drips', suffix);
  await page.goto('/templates');
  await page.getByRole('button', { name: /Sync from Meta/ }).click();
  // The sync reads every connected account one by one; wait for it to finish, not for an older account's row.
  await expect(page.getByText(/Templates synced/)).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText('order_confirmation').first()).toBeVisible();
  for (const p of people) {
    const res = await page.request.post('/api/contacts', {
      data: { phone: p.phone, name: p.name, tags: [tag], consentStatus: 'OPTED_IN', consentSourceNote: 'E2E drip list' },
      headers: await csrfHeaders(page),
    });
    expect(res.status(), await res.text()).toBe(201);
  }

  // Build the drip.
  await page.goto('/drips');
  await page.getByRole('button', { name: 'New drip' }).click();
  await page.getByLabel('Drip name').fill(dripName);
  await page.getByLabel('Send from').selectOption({ label: number.label });
  await page.getByRole('button', { name: 'Create drip' }).click();
  await expect(page).toHaveURL(/\/drips\/[0-9a-f-]{36}$/);

  for (const [i, wait] of [
    [1, '0'],
    [2, '10'],
  ] as const) {
    await page.getByRole('button', { name: 'Add step' }).click();
    const card = page.getByTestId(`drip-step-${i}`);
    await card.getByLabel('Template').selectOption({ label: 'order_confirmation · en_US' });
    await card.getByLabel('Wait').selectOption(wait);
    const body1 = card.getByTestId('step-mapping-BODY.1');
    await body1.getByLabel('Source').selectOption('field');
    await body1.getByLabel('Value').selectOption('name');
    const body2 = card.getByTestId('step-mapping-BODY.2');
    await body2.getByLabel('Source').selectOption('static');
    await body2.getByLabel('Value').fill('#E2E');
  }
  await page.getByRole('button', { name: 'Save steps' }).click();
  await expect(page.getByText('Steps saved')).toBeVisible();
  await page.getByRole('button', { name: 'Activate' }).click();
  await expect(page.getByTestId('drip-status')).toHaveText('Active');

  // Enrol both by their tag.
  await page.getByRole('button', { name: 'Enrol contacts' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Contacts with the tag').fill(tag);
  await dialog.getByRole('button', { name: 'Check' }).click();
  await expect(dialog.getByTestId('enrol-preview')).toContainText('2 will join');
  await dialog.getByRole('button', { name: 'Enrol' }).click();
  await expect(page.getByTestId('enrolment-row')).toHaveCount(2);

  // The tick sends step 1 to both within about 30 seconds.
  await expect(async () => {
    const sends = await sentMessages(page, number.phoneNumberId, 'order_confirmation');
    expect(new Set(sends.map((m) => `+${m.to}`))).toEqual(new Set(people.map((p) => p.phone)));
  }).toPass({ timeout: 90_000 });

  // Ann replies and leaves the drip.
  execSync(`npm run mock:inbound -- --from ${people[0]!.phone.slice(1)} --name "${people[0]!.name}" --text "Thanks, no more please" --phone-number-id ${number.phoneNumberId}`, {
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });
  await expect(async () => {
    await page.reload();
    await expect(page.getByTestId('enrolment-row').filter({ hasText: people[0]!.name })).toContainText('Left: replied');
  }).toPass({ timeout: 45_000 });
  await expect(page.getByTestId('enrolment-row').filter({ hasText: people[1]!.name })).toContainText('Waiting for step 2');

  // In live chat, the drip message is an automatic message from the drip.
  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: people[0]!.name });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await row.click();
  await expect(page.getByTestId('timeline').getByTestId('chat-item').filter({ hasText: `Drip "${dripName}" · step 1` })).toBeVisible();
});
