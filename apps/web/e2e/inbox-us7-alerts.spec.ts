import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T085: quickstart US7 row - the sound setting persists, and a registered browser appears in the
// device list and can be paused, resumed and removed. Sending the push itself is covered by the
// integration test (T083): headless browsers in CI have no push service to subscribe with.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

test.use({ permissions: ['notifications'] });

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('US7: sound setting and alert devices', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const diag = collectDiagnostics(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);

  await page.getByRole('link', { name: 'Alerts' }).click();
  await expect(page).toHaveURL(/\/account\/notifications/);
  const sound = page.getByLabel('Play a sound for new customer messages');
  await expect(sound).toBeEnabled();
  const before = await sound.isChecked();
  const saved = (response: { url(): string; request(): { method(): string } }) =>
    response.url().includes('/api/me/notification-preferences') && response.request().method() === 'PUT';
  await Promise.all([page.waitForResponse(saved), sound.click()]);
  await page.reload();
  await diag.check(() => expect(page.getByLabel('Play a sound for new customer messages')).toBeChecked({ checked: !before }));
  await Promise.all([page.waitForResponse(saved), page.getByLabel('Play a sound for new customer messages').click()]);

  const label = `E2E browser ${suffix}`;
  const registered = await page.request.post('/api/me/push-devices', {
    headers: await csrfHeaders(page),
    data: { endpoint: `https://push.example.test/e2e/${suffix}`, keys: KEYS, label },
  });
  expect(registered.status()).toBe(201);
  await page.reload();
  const device = page.getByTestId('push-device').filter({ hasText: label });
  await diag.check(() => expect(device).toBeVisible());
  await expect(device).toContainText('no alerts yet');

  await device.getByRole('button', { name: 'Pause' }).click();
  await expect(device).toContainText('Paused');
  await device.getByRole('button', { name: 'Resume' }).click();
  await expect(device).not.toContainText('Paused');
  await device.getByRole('button', { name: 'Remove' }).click();
  await diag.check(() => expect(device).toHaveCount(0));
});
