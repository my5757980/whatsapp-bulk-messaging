import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { MOCK_META, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T081 (feature 008, quickstart US7 row): build a two-screen form that saves the name and email to
// attributes and adds a tag, publish it, send it in a chat, answer it with the CLI using the token
// from /mock/sent, then see the answer in the chat, the contact's attributes and tag, and the answers list.

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('US7: a WhatsApp Form is built, published, sent and answered', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const phoneNumberId = `84${suffix}`;
  const customer = `+97154${suffix}6`;
  const name = `Lead ${suffix.slice(-4)}`;
  const nameKey = `lead_name_${suffix}`;
  const emailKey = `lead_email_${suffix}`;
  const tagName = `form-lead-${suffix}`;
  await signInAsAdmin(page);
  const headers = await csrfHeaders(page);
  expect((await page.request.post('/api/numbers', { headers, data: { label: `Forms ${suffix}`, wabaId: `MOCK_WABA_F${suffix}`, phoneNumberId, accessToken: 'mock-token' } })).status()).toBe(201);
  expect((await page.request.post('/api/attributes', { headers, data: { key: nameKey, label: 'Lead name', type: 'TEXT' } })).status()).toBe(201);
  expect((await page.request.post('/api/attributes', { headers, data: { key: emailKey, label: 'Lead email', type: 'TEXT' } })).status()).toBe(201);
  expect((await page.request.post('/api/tags', { headers, data: { name: tagName } })).status()).toBe(201);

  // 1. Build: screen 1 asks the name, screen 2 the email; both saved to attributes; a tag on answer.
  await page.goto('/forms');
  await page.getByRole('button', { name: 'New form' }).click();
  await page.getByLabel('Form name').fill(`Lead form ${suffix}`);
  await page.getByLabel('Kind').selectOption('LEAD_GENERATION');
  await page.getByRole('button', { name: 'Create form' }).click();
  await expect(page).toHaveURL(/\/forms\/[0-9a-f-]{36}$/);
  await page.getByLabel('Screen 1 button').fill('Continue');
  await page.getByTestId('form-screen-1').getByRole('button', { name: 'Add field' }).click();
  await page.getByLabel('Field 1 label').first().fill('Your name');
  await page.getByLabel('Field 1 key').first().fill('name');
  await page.getByLabel('Attribute for name').selectOption(nameKey);
  await page.getByRole('button', { name: 'Add screen' }).click();
  const second = page.getByTestId('form-screen-2');
  await second.getByLabel('Screen 2 title').fill('Contact');
  await second.getByRole('button', { name: 'Add field' }).click();
  await second.getByLabel('Field 1 label').fill('Your email');
  await second.getByLabel('Field 1 key').fill('email');
  await second.getByLabel('Field 1 type').selectOption('email');
  await page.getByLabel('Attribute for email').selectOption(emailKey);
  await page.getByLabel(tagName).check();
  await page.getByRole('button', { name: 'Check' }).click();
  await expect(page.getByTestId('form-ready')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Publish' }).click();
  await expect(page.getByTestId('form-status')).toHaveText('Published v1', { timeout: 30_000 });
  const formUrl = page.url();

  // 2. Send it in a chat.
  execSync(`npm run mock:inbound -- --from ${customer} --name "${name}" --text "I'd like a call back" --phone-number-id ${phoneNumberId}`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: name });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await page.getByRole('button', { name: 'Send form' }).click();
  const dialog = page.getByRole('dialog', { name: 'Send form' });
  await dialog.getByLabel('Form').selectOption({ label: `Lead form ${suffix}` });
  await dialog.getByLabel('Message').fill('Leave your details and we will call you');
  await dialog.getByLabel('Button').fill('Leave details');
  await dialog.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByTestId('form-message')).toBeVisible({ timeout: 15_000 });

  // 3. The customer answers with the token from the sent message.
  let token = '';
  await expect(async () => {
    const sent = (await (await page.request.get(`${MOCK_META}/mock/sent`)).json()) as { messages: Array<{ phoneNumberId: string; interactive?: { type?: string; action?: { parameters?: { flow_token?: string } } } }> };
    token = sent.messages.filter((m) => m.phoneNumberId === phoneNumberId && m.interactive?.type === 'flow').at(-1)?.interactive?.action?.parameters?.flow_token ?? '';
    expect(token).toMatch(/^wf1\./);
  }).toPass({ timeout: 30_000 });
  execSync(`npm run mock:inbound -- --from ${customer} --phone-number-id ${phoneNumberId} --form-reply ${token} --answers "{\\"name\\":\\"Sara Ahmed\\",\\"email\\":\\"sara@example.com\\"}"`, { cwd: REPO_ROOT, stdio: 'ignore' });

  // 4. The answer shows in the chat; the attributes and the tag are set; the answers list has it.
  await expect(page.getByTestId('form-reply')).toContainText('sara@example.com', { timeout: 30_000 });
  await expect
    .poll(async () => {
      const contacts = (await (await page.request.get(`/api/contacts?search=${encodeURIComponent(customer)}`)).json()) as { items: Array<{ attributes?: Record<string, unknown>; tags?: string[] }> };
      const c = contacts.items[0];
      return c ? `${String(c.attributes?.[nameKey] ?? '')}|${String(c.attributes?.[emailKey] ?? '')}|${(c.tags ?? []).includes(tagName)}` : '';
    }, { timeout: 30_000 })
    .toBe('Sara Ahmed|sara@example.com|true');
  await page.goto(`${formUrl}/answers`);
  await expect(page.getByTestId('form-answers')).toContainText('sara@example.com');
});
