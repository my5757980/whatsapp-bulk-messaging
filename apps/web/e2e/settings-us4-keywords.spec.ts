import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T052 (feature 010, quickstart US4 row): set the keyword replies, send STOP with the inbound CLI and see the
// reply in the chat; a second STOP the same day gets no second reply.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const REPLY = 'You will get no more messages from us. Reply START to come back.';

test('US4: a consent keyword gets its confirmation reply in the chat', async ({ page }) => {
  test.setTimeout(180_000);
  const suffix = Date.now().toString().slice(-6);
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Keywords', suffix);
  const customer = `+97150${suffix}3`;
  const name = `Keyword Sara ${suffix}`;

  try {
    await page.goto('/settings/keywords');
    const optOut = page.getByTestId('opt-out-reply');
    await optOut.getByLabel('Reply').selectOption('TEXT');
    await optOut.getByLabel('Text').fill(REPLY);
    await page.getByRole('button', { name: 'Save replies' }).click();
    await expect(page.getByText('Keyword replies saved')).toBeVisible();

    execSync(
      `npm run mock:inbound -- --from ${customer} --name "${name}" --text "STOP" --phone-number-id ${number.phoneNumberId}`,
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
    await page.goto('/inbox');
    const row = page.getByTestId('conversation-row').filter({ hasText: name });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.click();
    const timeline = page.getByTestId('timeline');
    await expect(timeline.getByTestId('chat-item').filter({ hasText: REPLY })).toHaveCount(1, {
      timeout: 15_000,
    });

    execSync(
      `npm run mock:inbound -- --from ${customer} --name "${name}" --text "stop" --phone-number-id ${number.phoneNumberId}`,
      { cwd: REPO_ROOT, stdio: 'ignore' },
    );
    await expect(timeline.getByTestId('chat-item').filter({ hasText: /^stop$/i })).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(timeline.getByTestId('chat-item').filter({ hasText: REPLY })).toHaveCount(1);
  } finally {
    // Other tests send STOP too; leave no reply behind.
    await page.request.put('/api/settings/keyword-replies', {
      headers: await csrfHeaders(page),
      data: { optOut: { kind: 'NONE' }, optIn: { kind: 'NONE' } },
    });
  }
});
