import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// T091: quickstart US8 row - a note with a mention is never sent to the customer and the teammate
// is alerted; the 7-day team view shows the same figures as the API.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const MEMBER_PASSWORD = 'E2e-Member-Password-1';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

/** Invites an agent from Settings > Team and signs them in, in a separate browser context. */
async function inviteAgent(admin: Page, browser: Browser, name: string, suffix: string): Promise<Page> {
  await admin.goto('/settings/team');
  await admin.getByRole('button', { name: 'Invite member' }).click();
  await admin.getByLabel('E-mail').fill(`notes.${suffix}@company.test`);
  await admin.getByLabel('Role', { exact: true }).selectOption('AGENT');
  await admin.getByRole('button', { name: 'Create invitation' }).click();
  const link = await admin.getByLabel('Invitation link').inputValue();
  await admin.keyboard.press('Escape');

  const member = await (await browser.newContext()).newPage();
  await member.goto(link);
  await member.getByLabel('Your name').fill(name);
  await member.getByLabel('Password (at least 12 characters)').fill(MEMBER_PASSWORD);
  await member.getByLabel('Repeat password').fill(MEMBER_PASSWORD);
  await member.getByRole('button', { name: 'Create my account' }).click();
  await expect(member).toHaveURL(/\/campaigns/);
  return member;
}

test('US8: notes with mentions and the team view', async ({ page, browser }) => {
  const suffix = String(Date.now()).slice(-8);
  const phoneNumberId = `86${suffix}`;
  const customer = `+97152${suffix.slice(-6)}8`;
  const name = `Rana ${suffix.slice(-4)}`;
  const mateName = `Mate${suffix}`;
  const diag = collectDiagnostics(page);

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const connect = await page.request.post('/api/numbers', {
    headers: await csrfHeaders(page),
    data: { label: `Notes ${suffix}`, wabaId: `MOCK_WABA_N8${suffix}`, phoneNumberId, accessToken: 'mock-token' },
  });
  expect(connect.status()).toBe(201);
  const mate = await inviteAgent(page, browser, mateName, suffix);
  execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --text "Hello" --phone-number-id ${phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await diag.check(() => expect(row).toBeVisible({ timeout: 15_000 }));
  await row.click();

  // A note that mentions the teammate.
  await page.getByRole('tab', { name: 'Note' }).click();
  const box = page.getByLabel('Note');
  await box.fill(`Please call back after 5pm @${mateName}`);
  await page.getByRole('listbox', { name: 'Mention a teammate' }).getByRole('button', { name: mateName }).click();
  await expect(box).toHaveValue(`Please call back after 5pm @${mateName} `);
  await page.getByRole('button', { name: 'Add note' }).click();
  const noteItem = page.getByTestId('chat-item').filter({ hasText: 'Please call back after 5pm' });
  await diag.check(() => expect(noteItem).toBeVisible({ timeout: 15_000 }));
  await expect(noteItem).toHaveAttribute('data-kind', 'NOTE');
  await expect(noteItem).toContainText('Internal note');

  // Never sent to the customer: the timeline item carries no delivery status.
  const conversationId = new URL(page.url()).searchParams.get('c');
  const items = await (await page.request.get(`/api/inbox/conversations/${conversationId}/items`)).json();
  const stored = (items.items ?? items).find((i: { kind: string; text: string | null }) => i.kind === 'NOTE' && i.text?.startsWith('Please call back'));
  expect(stored).toMatchObject({ status: null, origin: 'MEMBER' });

  // The teammate is alerted.
  await mate.goto('/inbox');
  await mate.getByRole('button', { name: /Notifications/ }).click();
  await diag.check(() => expect(mate.getByText('You were mentioned').first()).toBeVisible({ timeout: 30_000 }));

  // Take and close the chat, then compare the 7-day team view with the API.
  await page.getByRole('tab', { name: 'Reply' }).click();
  await page.getByRole('button', { name: 'Take chat' }).click();
  await expect(page.getByText('Taken · you')).toBeVisible();
  await page.getByRole('button', { name: 'Close chat' }).click();
  await expect(page.getByText('Taken · you')).toHaveCount(0, { timeout: 15_000 });

  await page.getByRole('link', { name: 'Team view →' }).click();
  await expect(page).toHaveURL(/\/inbox\/team/);
  await page.getByLabel('Period').selectOption('7d');
  const me = await (await page.request.get('/api/auth/me')).json();
  const metrics = await (await page.request.get('/api/inbox/team-metrics?period=7d')).json();
  const mine = metrics.members.find((m: { user: { id: string } }) => m.user.id === me.id);
  expect(mine.intervened).toBeGreaterThanOrEqual(1);
  expect(mine.resolved).toBeGreaterThanOrEqual(1);
  const myRow = page.getByTestId('team-member-row').filter({ has: page.getByRole('cell', { name: me.name, exact: true }) });
  await diag.check(() => expect(myRow.getByTestId('team-intervened')).toHaveText(String(mine.intervened)));
  await expect(myRow.getByTestId('team-resolved')).toHaveText(String(mine.resolved));
});
