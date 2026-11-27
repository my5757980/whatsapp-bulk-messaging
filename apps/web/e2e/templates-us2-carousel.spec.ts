import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { connectNumber, csrfHeaders, sentMessages, signInAsAdmin } from './growth-helpers';

// T033 (feature 009, quickstart US2 row): a 3-card carousel built in the editor and approved on mock-meta,
// a campaign with another library image on card 2 sent to three contacts, three carousel payloads with
// media ids on mock-meta, and a card 2 quick reply shown as "Card 2 · Tell me more" in live chat.
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

type SentCarousel = { cards?: Array<{ card_index: number; components: Array<{ type: string; parameters?: Array<{ image?: { id?: string } }> }> }> };

test('US2: a carousel with another image on card 2, three carousel sends and a card reply in live chat', async ({ page }) => {
  test.setTimeout(300_000);
  const suffix = Date.now().toString().slice(-6);
  const name = `new_arrivals_${suffix}`;
  await signInAsAdmin(page);
  const number = await connectNumber(page, 'Cards', suffix);

  // 1. The editor: three cards, each with a sample image, its text and the "Tell me more" quick reply.
  await page.goto('/templates/new');
  await page.getByLabel('Type').selectOption('CAROUSEL');
  await page.getByLabel('Account').selectOption(number.wabaId);
  await page.getByLabel('Template name').fill(name);
  await page.getByLabel('Message text').fill('Hi {{1}}, our new arrivals.');
  await page.getByLabel('Sample for {{1}}').fill('Sara');
  await page.getByRole('button', { name: 'Add card' }).click();
  for (const i of [1, 2, 3]) {
    await page.getByLabel(`Card ${i} sample image`).setInputFiles({ name: `card${i}.png`, mimeType: 'image/png', buffer: PNG });
    await expect(page.getByTestId(`card-${i}`)).toContainText('Sample uploaded.');
    await page.getByLabel(`Card ${i} text (up to 160 characters; all cards or none)`).fill(`Linen shirt ${i}, {{1}}`);
    await page.getByLabel(`Card ${i} sample for {{1}}`).fill('AED 120');
  }
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page).toHaveURL(/\/templates\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('template-status')).toHaveText('Approved', { timeout: 45_000 });

  // 2. Another image for card 2, in the media library.
  const library = await page.request.post('/api/media-library', {
    headers: await csrfHeaders(page),
    multipart: { file: { name: 'card2-new.png', mimeType: 'image/png', buffer: PNG }, displayName: `Card 2 new ${suffix}` },
  });
  expect(library.status(), await library.text()).toBe(201);

  // 3. The campaign: three uploaded contacts.
  const phones = [1, 2, 3].map((n) => `+97150${suffix}${n}`);
  await page.goto('/campaigns/new');
  await page.getByLabel('Campaign name').fill(`Carousel ${suffix}`);
  await page.getByLabel('Send from').selectOption({ label: `${number.label} (+1 555 010 0000)` });
  await page.getByLabel('Approved template').selectOption({ label: `${name} · en_US · Marketing` });
  await page.getByRole('button', { name: 'Save and continue' }).click();
  await page.getByLabel(/Recipient list/).setInputFiles({
    name: 'contacts.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from(`name,phone\n${phones.map((p, i) => `Buyer ${i + 1},${p}`).join('\n')}\n`),
  });
  await expect(page.getByLabel('Phone number column')).toHaveValue('phone');
  await page.getByLabel(/I confirm every contact/).check();
  await page.getByLabel('Where did they opt in?').fill('E2E carousel list');
  await page.getByRole('button', { name: 'Upload list' }).click();
  await expect(page.getByTestId('upload-summary')).toContainText('3 rows processed', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Continue' }).click();

  // 4. Mapping: the name, each card's price, and the library image on card 2; the check uploads the files.
  await page.getByTestId('mapping-BODY.1').getByLabel('Value from').selectOption('name');
  for (const i of [0, 1, 2]) {
    const row = page.getByTestId(`mapping-CARD.${i}.BODY.1`);
    await expect(row).toContainText(`Card ${i + 1} text`);
    await row.getByLabel('Source').selectOption('static');
    await row.getByLabel('Text').fill(`AED ${100 + i}`);
  }
  const cards = page.getByTestId('card-media');
  await expect(cards.getByTestId('card-media-0')).toContainText('Linen shirt 1');
  await cards.getByLabel('Card 2 image').selectOption({ label: `Card 2 new ${suffix}` });
  await cards.getByRole('button', { name: 'Check card files' }).click();
  for (const i of [0, 1, 2]) await expect(page.getByTestId(`card-media-result-${i}`)).toHaveText('Ready', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Save and continue' }).click();

  await expect(page.getByTestId('eligible-count')).toHaveText('3');
  await page.getByRole('button', { name: 'Send now' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Send now' }).click();
  await expect(page).toHaveURL(/\/campaigns\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('campaign-state')).toHaveText('Completed', { timeout: 90_000 });

  // 5. Three carousel payloads, each card with a media id; card 2 differs from the other cards.
  await expect(async () => {
    const sent = await sentMessages(page, number.phoneNumberId, name);
    expect(sent).toHaveLength(3);
    for (const m of sent) {
      const carousel = m.components?.find((c) => c.type === 'carousel') as SentCarousel | undefined;
      expect(carousel?.cards?.map((c) => c.card_index)).toEqual([0, 1, 2]);
      const ids = (carousel?.cards ?? []).map((c) => c.components.find((p) => p.type === 'header')?.parameters?.[0]?.image?.id);
      expect(ids.every(Boolean)).toBe(true);
      expect(new Set(ids).size).toBe(3);
    }
  }).toPass({ timeout: 60_000 });

  // 6. The first buyer taps card 2's quick reply: live chat says which card.
  execSync(`npm run mock:inbound -- --from ${phones[0]} --phone-number-id ${number.phoneNumberId} --button-payload "wbm:c1:b0" --button-text "Tell me more"`, { cwd: REPO_ROOT, stdio: 'ignore' });
  await page.goto('/inbox');
  const row = page.getByTestId('conversation-row').filter({ hasText: 'Buyer 1' }).filter({ hasText: 'Card 2 · Tell me more' });
  await expect(row).toBeVisible({ timeout: 20_000 });
  await row.click();
  await expect(page.getByTestId('timeline').getByTestId('card-reply')).toHaveText('Card 2 · Tell me more');
});
