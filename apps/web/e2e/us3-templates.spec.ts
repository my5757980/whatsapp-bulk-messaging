import { expect, test, type Page } from '@playwright/test';

// T136: quickstart US3 row - an invalid name is blocked; a marketing template with one variable
// and a URL button goes Pending -> Approved without a manual refresh (mock-meta approves after ~10 s).
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US3: create a template and watch it get approved', async ({ page }) => {
  const suffix = Date.now().toString().slice(-6);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  // A connected mock number for the account the template belongs to.
  const wabaId = `MOCK_WABA_T${suffix}`;
  const connect = await page.request.post('/api/numbers', {
    data: { label: `Templates ${suffix}`, wabaId, phoneNumberId: `30${suffix}`, accessToken: 'mock-token' },
    headers: await csrfHeaders(page),
  });
  expect(connect.status()).toBe(201);

  await page.goto('/templates/new');
  await page.getByLabel('Account').selectOption(wabaId); // waits until the option has loaded

  // Invalid name: the editor shows the problem next to the field and does not submit.
  await page.getByLabel('Template name').fill('Summer Offer');
  await page.getByLabel('Message text').fill('Hi {{1}}, our summer sale is on!');
  await page.getByLabel('Sample for {{1}}').fill('Sara');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText(/lower-case letters, numbers and underscores/)).toBeVisible();
  await expect(page).toHaveURL(/\/templates\/new/);

  await page.getByLabel('Template name').fill(`e2e_summer_${suffix}`);
  await page.getByLabel('Category').selectOption('MARKETING');
  await page.getByRole('button', { name: 'Add website button' }).click();
  await page.getByLabel('Button 1 text').fill('Shop now');
  await page.getByLabel('Button 1 link').fill('https://shop.example.com/{{1}}');
  await page.getByLabel('Button 1 sample').fill('summer');
  await page.getByRole('button', { name: 'Submit for review' }).click();

  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('template-status')).toHaveText('Pending');
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });
});
