import { execSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, signInAsAdmin } from './growth-helpers';

// T020 (feature 006, quickstart US1 row): an endpoint on the mock-meta catcher gets signed events
// for a template's statuses and a customer reply; events sent while it is paused arrive on resume.
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

interface Caught {
  headers: Record<string, string>;
  body: string;
}

const caughtAt = async (name: string): Promise<Caught[]> => ((await (await fetch(`${MOCK_META}/catch/${name}`)).json()) as { requests: Caught[] }).requests;
const typesOf = (requests: Caught[]) => requests.map((r) => (JSON.parse(r.body) as { type: string }).type);
/** The Standard Webhooks check a receiver makes: HMAC-SHA256 of id.timestamp.body with the decoded secret. */
const signatureChecks = (c: Caught, secret: string) => {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  const expected = createHmac('sha256', key).update(`${c.headers['webhook-id']}.${c.headers['webhook-timestamp']}.${c.body}`).digest('base64');
  return (c.headers['webhook-signature'] ?? '').split(' ').some((v) => v === `v1,${expected}`);
};

test('US1: signed webhooks for statuses and replies, with pause and resume', async ({ page, playwright, baseURL }) => {
  test.setTimeout(240_000);
  const suffix = Date.now().toString().slice(-6);
  const catcher = `crm${suffix}`;
  await fetch(`${MOCK_META}/catch/${catcher}`, { method: 'DELETE' });

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Hooks', suffix);
  await page.request.post('/api/templates/sync', { headers: await csrfHeaders(page) });

  // 1. Add the endpoint in the settings page and keep the secret shown once.
  await page.goto('/settings/webhooks');
  await page.getByRole('button', { name: 'Add endpoint' }).click();
  await page.getByLabel('Name').fill(`CRM ${suffix}`);
  await page.getByLabel('Address').fill(`${MOCK_META}/catch/${catcher}`);
  await page.getByRole('checkbox', { name: /Message status/ }).check();
  await page.getByRole('checkbox', { name: /Customer message received/ }).check();
  await page.getByRole('button', { name: 'Save endpoint' }).click();
  const secret = await page.getByRole('textbox', { name: 'Signing secret' }).inputValue();
  expect(secret).toMatch(/^whsec_/);
  await page.getByRole('button', { name: 'I have stored it' }).click();
  await expect(page).toHaveURL(/\/settings\/webhooks\/[0-9a-f-]{36}$/);

  // 2. The test event.
  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect(page.getByTestId('test-result')).toContainText('200');
  await expect(async () => expect(typesOf(await caughtAt(catcher))).toContain('test.ping')).toPass({ timeout: 15_000 });

  // 3. A template to two contacts through the public API, and a reply from one.
  const key = await (await page.request.post('/api/api-keys', { data: { name: `Hooks ${suffix}` }, headers: await csrfHeaders(page) })).json();
  const client = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${key.secret}` } });
  const numbers = (await (await page.request.get('/api/numbers')).json()) as Array<{ id: string; phoneNumberId: string }>;
  const numberId = numbers.find((n) => n.phoneNumberId === number.phoneNumberId)!.id;
  const phones = [`+97152${suffix}1`, `+97152${suffix}2`];
  for (const to of phones) {
    const sent = await client.post('/api/v1/messages', { data: { numberId, to, template: { name: 'order_confirmation', language: 'en_US' }, params: { 'BODY.1': 'Sara', 'BODY.2': '#HOOK' } } });
    expect(sent.status()).toBe(202);
  }
  execSync(`npm run mock:inbound -- --from ${phones[0]} --name "Sara" --phone-number-id ${number.phoneNumberId} --text "please call me"`, { cwd: REPO_ROOT, stdio: 'ignore' });

  await expect(async () => {
    const types = typesOf(await caughtAt(catcher));
    expect(types.filter((t) => t === 'message.status').length).toBeGreaterThanOrEqual(6);
    expect(types).toContain('message.received');
  }).toPass({ timeout: 90_000 });
  const requests = await caughtAt(catcher);
  for (const r of requests) expect(signatureChecks(r, secret)).toBe(true);
  expect(new Set(requests.map((r) => r.headers['webhook-id'])).size).toBe(requests.length);

  await page.reload();
  await expect(page.getByTestId('delivery-row').first()).toBeVisible();
  await expect(page.getByTestId('delivery-row').filter({ hasText: 'Delivered' }).first()).toBeVisible();

  // 4. Pause, send, resume: the waiting event arrives.
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByTestId('endpoint-status')).toHaveText('Paused');
  const before = (await caughtAt(catcher)).length;
  execSync(`npm run mock:inbound -- --from ${phones[1]} --name "Omar" --phone-number-id ${number.phoneNumberId} --text "is my order ready"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await page.waitForTimeout(5_000);
  expect((await caughtAt(catcher)).length).toBe(before);
  await page.getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByTestId('endpoint-status')).toHaveText('Active');
  await expect(async () => {
    const after = await caughtAt(catcher);
    expect(after.length).toBeGreaterThan(before);
    expect(after.slice(before).some((r) => (JSON.parse(r.body) as { type: string }).type === 'message.received')).toBe(true);
  }).toPass({ timeout: 60_000 });
  await client.dispose();
});
