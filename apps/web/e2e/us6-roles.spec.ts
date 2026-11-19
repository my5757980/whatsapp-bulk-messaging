import { expect, test, type Browser, type Page } from '@playwright/test';

// T170: quickstart US6 row - invite a manager and an agent, check what each can do, masked phones
// for the agent, and the audit entries for the admin's actions.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const MEMBER_PASSWORD = 'E2e-Member-Password-1';

async function signIn(page: Page, email: string, password: string) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
}

async function inviteAndAccept(admin: Page, browser: Browser, role: 'MANAGER' | 'AGENT', suffix: string): Promise<Page> {
  const email = `${role.toLowerCase()}.${suffix}@company.test`;
  await admin.goto('/settings/team');
  await admin.getByRole('button', { name: 'Invite member' }).click();
  await admin.getByLabel('E-mail').fill(email);
  await admin.getByLabel('Role').selectOption(role);
  await admin.getByRole('button', { name: 'Create invitation' }).click();
  const link = await admin.getByLabel('Invitation link').inputValue();
  await admin.keyboard.press('Escape');

  const member = await (await browser.newContext()).newPage();
  await member.goto(link);
  await member.getByLabel('Your name').fill(`${role} ${suffix}`);
  await member.getByLabel('Password (at least 12 characters)').fill(MEMBER_PASSWORD);
  await member.getByLabel('Repeat password').fill(MEMBER_PASSWORD);
  await member.getByRole('button', { name: 'Create my account' }).click();
  await expect(member).toHaveURL(/\/campaigns/);
  return member;
}

test('US6: roles, masking and the audit log', async ({ page, browser }) => {
  const suffix = Date.now().toString().slice(-6);
  await signIn(page, ADMIN_EMAIL, ADMIN_PASSWORD);

  const manager = await inviteAndAccept(page, browser, 'MANAGER', suffix);
  const agent = await inviteAndAccept(page, browser, 'AGENT', suffix);

  // Manager: can create campaigns, cannot manage the team.
  await expect(manager.getByRole('link', { name: 'New campaign' })).toBeVisible();
  await manager.goto('/settings/team');
  await expect(manager.getByText('Your role does not have access to this page.')).toBeVisible();

  // Agent: read-only, masked phone numbers, no campaign creation.
  await agent.goto('/campaigns');
  await expect(agent.getByRole('link', { name: 'New campaign' })).toHaveCount(0);
  await agent.goto('/contacts');
  const firstPhone = agent.getByTestId('contact-row').first().locator('.text-xs').first();
  await expect(firstPhone).toHaveText(/^•••• \d{4}$/);
  await agent.goto('/campaigns/new');
  await expect(agent.getByText('Your role does not have access to this page.')).toBeVisible();

  // Admin: the audit log shows the invitations and the new members' sign-ins.
  await page.goto('/settings/audit');
  await page.getByLabel('Action').selectOption('user.invited');
  await expect(page.getByTestId('audit-row').first()).toContainText('user.invited');
  await expect(page.getByTestId('audit-row').first()).toContainText(`agent.${suffix}@company.test`);
});
