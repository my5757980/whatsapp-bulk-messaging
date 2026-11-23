import { expect, test, type Page } from '@playwright/test';
import { collectDiagnostics } from './diagnostics';

// 004 T099: quickstart US9 row - the assistant drafts a template (a fake model tool call) that opens
// in the template editor unsubmitted, then prepares a campaign send that runs only after Confirm.
const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@company.test';
const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'ChangeMe-12345';
const MOCK_META = process.env.MOCK_META_URL ?? 'http://localhost:4010';

test.setTimeout(3 * 60_000);

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const csrf = (await page.context().cookies()).find((c) => c.name === 'csrf');
  return { 'x-csrf-token': decodeURIComponent(csrf?.value ?? '') };
}

test('AI US9: the assistant drafts a template and sends a campaign only after the member confirms', async ({ page }) => {
  const suffix = String(Date.now()).slice(-8);
  const diag = collectDiagnostics(page);
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN_EMAIL);
  await page.getByLabel('Password').fill(ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/campaigns/);
  const headers = await csrfHeaders(page);

  // A number, the synced templates, and a draft campaign with two uploaded recipients.
  const created = await page.request.post('/api/numbers', { headers, data: { label: `AI US9 ${suffix}`, wabaId: `MOCK_WABA_AI9${suffix}`, phoneNumberId: `44${suffix}`, accessToken: 'mock-token' } });
  expect(created.status()).toBe(201);
  const number = (await created.json()) as { id: string; wabaId: string };
  await page.request.post('/api/templates/sync', { headers });
  const templates = (await (await page.request.get(`/api/templates?wabaId=${number.wabaId}&status=APPROVED`)).json()) as Array<{ id: string; name: string }>;
  const template = templates.find((t) => t.name === 'order_confirmation');
  expect(template).toBeTruthy();
  const campaignName = `Assistant send ${suffix}`;
  const campaign = (await (
    await page.request.post('/api/campaigns', { headers, data: { name: campaignName, numberId: number.id, templateId: template!.id, audienceType: 'UPLOAD' } })
  ).json()) as { id: string };
  const rows = `name,phone\nAmal,+97150${suffix.slice(-6)}1\nOmar,+97150${suffix.slice(-6)}2\n`;
  const upload = await page.request.post(`/api/campaigns/${campaign.id}/audience-upload`, {
    headers,
    multipart: {
      file: { name: 'assistant.csv', mimeType: 'text/csv', buffer: Buffer.from(rows) },
      phoneColumn: 'phone',
      nameColumn: 'name',
      optInConfirmed: 'true',
      optInSourceNote: 'E2E assistant list',
    },
  });
  expect(upload.status()).toBe(202);
  const job = (await upload.json()) as { id: string };
  await expect(async () => {
    const status = (await (await page.request.get(`/api/imports/${job.id}`)).json()) as { status: string };
    expect(status.status).toBe('COMPLETED');
  }).toPass({ timeout: 60_000 });
  await page.request.patch(`/api/campaigns/${campaign.id}`, {
    headers,
    data: { variableMapping: { 'BODY.1': { source: 'column', key: 'name' }, 'BODY.2': { source: 'static', value: `#A${suffix}` } } },
  });

  // The fake model: a template draft for one question, a send proposal for the other.
  const templatePrompt = `Write a weekend sale template ${suffix} with a Shop now button`;
  const sendPrompt = `Send campaign ${suffix} now`;
  const rules = [
    {
      when: { lastUserContains: `weekend sale template ${suffix}`, hasToolResult: false },
      toolCall: {
        name: 'draft_template',
        input: {
          name: `weekend_sale_${suffix}`,
          language: 'en',
          category: 'MARKETING',
          headerText: null,
          body: 'Our weekend sale is on: 20% off everything.',
          bodyExamples: [],
          footer: null,
          buttons: [{ type: 'URL', text: 'Shop now', url: 'https://shop.example.com/sale', phoneNumber: null }],
        },
      },
    },
    { when: { lastUserContains: `weekend sale template ${suffix}`, hasToolResult: true }, text: 'I drafted the weekend sale template. Review it and submit it from the template editor.' },
    { when: { lastUserContains: `send campaign ${suffix}`, hasToolResult: false }, toolCall: { name: 'propose_campaign_send', input: { campaignId: campaign.id, sendAt: null } } },
    { when: { lastUserContains: `send campaign ${suffix}`, hasToolResult: true }, text: 'Check the preview and confirm to send it.' },
  ];
  expect((await page.request.post(`${MOCK_META}/mock/ai/rules`, { data: rules })).ok()).toBe(true);

  // Ask for the template: the draft opens in the template editor, not submitted.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Ask the assistant').fill(templatePrompt);
  await dialog.getByRole('button', { name: 'Ask', exact: true }).click();
  const templateRequest = dialog.getByTestId('assistant-request').filter({ hasText: templatePrompt });
  await diag.check(() => expect(templateRequest.getByTestId('assistant-reply')).toContainText('I drafted the weekend sale template', { timeout: 45_000 }));
  await templateRequest.getByTestId('assistant-draft').filter({ hasText: `weekend_sale_${suffix}` }).click();
  await expect(page).toHaveURL(/\/templates\/new\?from=[0-9a-f-]{36}&draft=1$/);
  await expect(page.getByRole('heading', { name: 'Review template draft' })).toBeVisible();
  await expect(page.getByLabel('Template name')).toHaveValue(`weekend_sale_${suffix}`, { timeout: 15_000 });
  await expect(page.getByLabel('Button 1 text')).toHaveValue('Shop now');
  const drafts = (await (await page.request.get('/api/templates?status=DRAFT')).json()) as Array<{ name: string; status: string }>;
  expect(drafts.find((t) => t.name === `weekend_sale_${suffix}`)?.status).toBe('DRAFT');

  // Ask to send the campaign: a preview with the recipients, and nothing sent until Confirm.
  await page.getByRole('button', { name: 'Assistant', exact: true }).click();
  await page.getByRole('dialog').getByLabel('Ask the assistant').fill(sendPrompt);
  await page.getByRole('dialog').getByRole('button', { name: 'Ask', exact: true }).click();
  const action = page.getByRole('dialog').getByTestId('assistant-request').filter({ hasText: sendPrompt }).getByTestId('assistant-action');
  await diag.check(() => expect(action).toContainText(`Send “${campaignName}” now`, { timeout: 45_000 }));
  await expect(action.getByTestId('assistant-recipients')).toHaveText('2');
  const state = async () => ((await (await page.request.get(`/api/campaigns/${campaign.id}`)).json()) as { state: string }).state;
  expect(await state()).toBe('DRAFT');
  await action.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(action).toContainText('Done');
  await expect.poll(state, { timeout: 15_000 }).toMatch(/RUNNING|COMPLETED/);
});
