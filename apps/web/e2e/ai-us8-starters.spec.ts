import { expect, test } from '@playwright/test';

// 004 T093: quickstart US8 row - an agent from the "Lead qualification" starter: create the attributes
// it offers, see publishing refused while example answers are marked "replace me", replace or remove
// them, and publish.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';

interface StarterSummary {
  key: string;
  suggestedAttributes: Array<{ key: string; label: string; exists: boolean }>;
}

test('AI US8: an agent from the Lead qualification starter publishes once its examples are replaced', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const name = `Leads ${suffix}`;

  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  // Which of its attributes exist decides whether the dialog offers to create them (a re-run has them).
  const starters = (await (await page.request.get('/api/ai-agent-starters')).json()) as StarterSummary[];
  const lead = starters.find((s) => s.key === 'lead_qualification')!;
  const missing = lead.suggestedAttributes.filter((a) => !a.exists);

  await page.goto('/ai-agents');
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Start from').selectOption({ label: 'Lead qualification' });
  await expect(dialog.getByTestId('starter-description')).toContainText('budget');
  await dialog.getByRole('button', { name: 'Create agent', exact: true }).click();
  if (missing.length) {
    for (const a of missing) await expect(dialog.getByTestId('missing-attributes')).toContainText(a.label);
    await dialog.getByRole('button', { name: 'Create attributes and open', exact: true }).click();
  }
  await expect(page).toHaveURL(/\/ai-agents\/[0-9a-f-]{36}$/);
  const attributes = (await (await page.request.get('/api/attributes')).json()) as Array<{ key: string }>;
  for (const a of lead.suggestedAttributes) expect(attributes.map((x) => x.key)).toContain(a.key);

  // Our texts are in the draft; publishing waits for the example answers.
  await expect(page.getByLabel('Goal', { exact: true })).toHaveValue(/budget/);
  await expect(page.getByTestId('problems')).toContainText('marked "replace me"');
  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Fix 1 problem before publishing')).toBeVisible();

  // Replace one example and remove the other two.
  await page.getByRole('tab', { name: 'Knowledge' }).click();
  const rows = page.getByTestId('knowledge-row');
  await expect(rows.filter({ hasText: 'Replace me' })).toHaveCount(3);
  const services = rows.filter({ hasText: 'What services do you offer?' });
  await services.getByRole('button', { name: 'Edit', exact: true }).click();
  const edit = page.getByRole('dialog');
  await edit.getByLabel('Answer', { exact: true }).fill(`We build online shops for small businesses (${suffix}).`);
  await edit.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(services).not.toContainText('Replace me');
  for (const question of ['How much do your services cost?', 'How soon can you start?']) {
    const row = rows.filter({ hasText: question });
    await row.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(row).toHaveCount(0);
  }

  await page.getByRole('button', { name: 'Publish', exact: true }).click();
  await expect(page.getByText('Published · v1')).toBeVisible({ timeout: 15_000 });
});
