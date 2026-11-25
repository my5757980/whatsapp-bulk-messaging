import { TokenCipher } from '../../src/common/crypto/token-cipher.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import type { TestContext } from './test-context.js';

// Feature 007 test helpers: one saved ads connection (the table holds one row), with known tokens.

export const ADS_TOKEN = 'EAAGads-system-user-token-0001';
export const ADS_PAGE_TOKEN = 'EAAGads-page-token-0001';
export const ADS_ACCOUNT_ID = '111';
export const ADS_PAGE_ID = 'P1';

/** Replaces any saved connection with a working one for account 111 and page P1 (AED, Asia/Dubai). */
export async function seedAdsConnection(ctx: TestContext, overrides: Partial<Prisma.AdsConnectionUncheckedCreateInput> = {}) {
  const cipher = new TokenCipher(process.env.TOKEN_ENCRYPTION_KEY as string);
  await ctx.prisma.adsConnection.deleteMany();
  return ctx.prisma.adsConnection.create({
    data: {
      adAccountId: ADS_ACCOUNT_ID,
      adAccountName: 'Acme ads',
      pageId: ADS_PAGE_ID,
      pageName: 'Acme',
      tokenEnc: cipher.encrypt(ADS_TOKEN),
      pageTokenEnc: cipher.encrypt(ADS_PAGE_TOKEN),
      currency: 'AED',
      timezone: 'Asia/Dubai',
      status: 'CONNECTED',
      checks: { checks: [], ready: true, linkedNumbers: null },
      checkedAt: new Date(),
      ...overrides,
    },
  });
}

/** Removes every ads row so a test file starts clean (files share one database). */
export async function clearAds(ctx: TestContext): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    'TRUNCATE ad_link_opens, ad_leads, ad_chat_starts, ad_result_days, ad_versions, ad_audience_members, ad_campaigns, ad_audiences, ad_lead_forms, ads_connections CASCADE',
  );
}
