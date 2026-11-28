import { expect, test } from '@playwright/test';
import {
  PREVIEW_UA,
  codesByPhone,
  connectNumber,
  createTrackedTemplate,
  openTrackedLink,
  sendTrackedCampaign,
  sentMessages,
  signInAsAdmin,
} from './growth-helpers';

// T029 (feature 005, quickstart US2 row): from a campaign's results, see the group sizes, retarget
// the people who clicked, and send the draft only to them.
test('US2: retarget the people who clicked', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const templateName = `e2e_retarget_${suffix}`;
  const phones = [1, 2, 3].map((i) => `+97152${suffix}${i}`);

  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Retarget', suffix);
  await createTrackedTemplate(page, number.wabaId, templateName);
  const campaignUrl = await sendTrackedCampaign(page, {
    name: `E2E retarget source ${suffix}`,
    numberLabel: number.label,
    templateName,
    phones,
    destination: 'https://shop.example/eid',
  });

  // Two people click; the third only gets a link preview, which does not count.
  const codes = await codesByPhone(page, number.phoneNumberId, templateName, 3);
  expect((await openTrackedLink(page, codes.get(phones[0]!)!)).status()).toBe(302);
  expect((await openTrackedLink(page, codes.get(phones[1]!)!)).status()).toBe(302);
  expect((await openTrackedLink(page, codes.get(phones[2]!)!, PREVIEW_UA)).status()).toBe(302);

  // The dialog counts once when it opens, so wait until the clicks and the third delivered status are in.
  const campaignId = campaignUrl.split('/').pop()!;
  const groupCount = async (status: string) =>
    ((await (await page.request.get(`/api/campaigns/${campaignId}/retarget-groups`)).json()) as { groups: Array<{ status: string; count: number }> }).groups.find((g) => g.status === status)?.count;
  await expect.poll(() => groupCount('CLICKED'), { timeout: 60_000 }).toBe(2);
  await expect.poll(() => groupCount('NOT_CLICKED'), { timeout: 60_000 }).toBe(1);
  await page.goto(`${campaignUrl}/report`);
  await page.getByRole('button', { name: 'Retarget…' }).click();
  await expect(page.getByTestId('retarget-count-CLICKED')).toHaveText('2', { timeout: 30_000 });
  await expect(page.getByTestId('retarget-count-NOT_CLICKED')).toHaveText('1');
  await expect(page.getByTestId('retarget-count-REPLIED')).toHaveText('0');
  await expect(page.getByTestId('retarget-REPLIED').getByRole('radio')).toBeDisabled();
  await page.getByTestId('retarget-CLICKED').getByRole('radio').check();
  await page.getByRole('button', { name: 'Create draft' }).click();

  // The draft names its source and group, keeps the tracked button, and goes to the clickers only.
  await expect(page).toHaveURL(/\/campaigns\/new\?id=.+&step=2/);
  await expect(page.getByTestId('retarget-audience')).toContainText('opened a link');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('mapping-BUTTON.0.1').getByLabel('Destination address')).toHaveValue('https://shop.example/eid');
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await expect(page.getByTestId('eligible-count')).toHaveText('2');
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });

  await expect(async () => {
    const sends = await sentMessages(page, number.phoneNumberId, templateName);
    const perPhone = (phone: string) => sends.filter((m) => `+${m.to}` === phone).length;
    expect([perPhone(phones[0]!), perPhone(phones[1]!), perPhone(phones[2]!)]).toEqual([2, 2, 1]);
  }).toPass({ timeout: 30_000 });
});
