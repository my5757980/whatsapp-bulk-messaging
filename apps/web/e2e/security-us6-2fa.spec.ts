import { expect, test, type Browser, type Page } from '@playwright/test';
import { csrfHeaders, signInAsAdmin } from './growth-helpers';
import { totp } from './totp';

// T067 (feature 010, quickstart US6 row): a member turns on two-factor sign-in with codes computed from the
// shown key, signs out and in with a code; the admin requires 2FA and a new member sets it up at sign-in; the
// admin resets a member. The requirement is switched off again at the end, since other tests sign in too.
const PASSWORD = 'E2e-Two-Factor-Pass-1';

async function invite(admin: Page, browser: Browser, email: string, name: string): Promise<Page> {
  await admin.goto('/settings/team');
  await admin.getByRole('button', { name: 'Invite member' }).click();
  await admin.getByLabel('E-mail').fill(email);
  await admin.getByLabel('Role', { exact: true }).selectOption('AGENT');
  await admin.getByRole('button', { name: 'Create invitation' }).click();
  const link = await admin.getByLabel('Invitation link').inputValue();
  await admin.keyboard.press('Escape');
  const member = await (await browser.newContext()).newPage();
  await member.goto(link);
  await member.getByLabel('Your name').fill(name);
  await member.getByLabel('Password (at least 12 characters)').fill(PASSWORD);
  await member.getByLabel('Repeat password').fill(PASSWORD);
  await member.getByRole('button', { name: 'Create my account' }).click();
  await expect(member).toHaveURL(/\/campaigns/);
  return member;
}

async function passwordStep(page: Page, email: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

test('US6: two-factor sign-in, the company requirement and an admin reset', async ({ page, browser }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  try {
    // 1. A member turns it on from the shown key.
    const email = `tfa.${suffix}@company.test`;
    const member = await invite(page, browser, email, `Two Factor ${suffix}`);
    await member.goto('/account/two-factor');
    await member.getByRole('button', { name: 'Turn on two-factor sign-in' }).click();
    const secret = (await member.getByTestId('totp-secret').textContent())!.trim();
    await member.getByLabel('Code from your app').fill(totp(secret));
    await member.getByRole('button', { name: 'Confirm' }).click();
    await expect(member.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    await member.getByRole('button', { name: 'I saved my codes' }).click();
    await expect(member.getByTestId('two-factor-status')).toHaveText('On');

    // 2. Signing in again needs a code (the next step: each code works once).
    await member.getByRole('button', { name: 'Sign out' }).click();
    await passwordStep(member, email);
    await expect(member.getByText('Enter the 6-digit code from your authenticator app.')).toBeVisible();
    await member.getByLabel('Code from your app').fill('000000');
    await member.getByRole('button', { name: 'Sign in' }).click();
    await expect(member.getByText('That code is not right')).toBeVisible();
    await member.getByLabel('Code from your app').fill(totp(secret, 1));
    await member.getByRole('button', { name: 'Sign in' }).click();
    await expect(member).toHaveURL(/\/campaigns/);

    // 3. The admin requires 2FA; a new member sets it up at sign-in.
    await page.goto('/settings/security');
    const require2fa = page.getByLabel('Require two-factor sign-in for every member');
    await require2fa.click();
    await expect(require2fa).toBeChecked();
    await expect(page.getByText('Two-factor sign-in is now required')).toBeVisible();
    const newEmail = `tfa.new.${suffix}@company.test`;
    const newcomer = await invite(page, browser, newEmail, `Newcomer ${suffix}`);
    await expect(newcomer.getByTestId('two-factor-banner')).toBeVisible();
    await newcomer.getByRole('button', { name: 'Sign out' }).click();
    await passwordStep(newcomer, newEmail);
    await newcomer.getByRole('button', { name: 'Start setup' }).click();
    const newSecret = (await newcomer.getByTestId('totp-secret').textContent())!.trim();
    await newcomer.getByLabel('Code from your app').fill(totp(newSecret));
    await newcomer.getByRole('button', { name: 'Confirm' }).click();
    await expect(newcomer.getByTestId('recovery-codes').locator('li')).toHaveCount(10);
    await newcomer.getByRole('button', { name: 'I saved my codes, continue' }).click();
    await expect(newcomer).toHaveURL(/\/campaigns/);
    await expect(newcomer.getByTestId('two-factor-banner')).toHaveCount(0);

    // 4. The admin resets the first member, who is signed out.
    await page.goto('/settings/security');
    await page.getByTestId('security-member').filter({ hasText: email }).getByRole('button', { name: 'Reset' }).click();
    await expect(page.getByText('Two-factor sign-in reset; the member was signed out')).toBeVisible();
    await member.goto('/campaigns');
    await expect(member).toHaveURL(/\/login/);
  } finally {
    await page.request.put('/api/settings/security', { headers: await csrfHeaders(page), data: { require2fa: false } });
  }
});
