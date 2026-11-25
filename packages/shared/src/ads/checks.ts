// The ads connection checks (feature 007, FR-002, research R2), built from Graph answers like the 006
// number wizard: each check is passed, failed or a warning, with a plain fix.

export type AdsCheckName =
  | 'TOKEN_VALID'
  | 'TOKEN_PERMISSIONS'
  | 'TOKEN_EXPIRY'
  | 'AD_ACCOUNT_ACTIVE'
  | 'AD_ACCOUNT_PAYMENT'
  | 'AD_ACCOUNT_CURRENCY'
  | 'PAGE_ADS'
  | 'PAGE_WHATSAPP_NUMBERS'
  | 'AUDIENCE_TERMS'
  | 'LEAD_TERMS';

export interface AdsCheck {
  check: AdsCheckName;
  result: 'PASSED' | 'FAILED' | 'WARNING';
  detail: string;
  fix: string | null;
}

/** Without these, ads cannot be managed at all. */
export const ADS_CORE_PERMISSIONS = ['ads_management', 'ads_read', 'business_management', 'pages_show_list', 'pages_read_engagement'] as const;
/** Without these, one part stops working: lead forms, leads, or the pre-filled chat message. */
export const ADS_PART_PERMISSIONS: Record<string, string> = {
  pages_manage_ads: 'lead forms',
  pages_manage_metadata: 'lead notifications',
  leads_retrieval: 'receiving leads',
  whatsapp_business_management: 'the pre-filled chat message',
};

const passed = (check: AdsCheckName, detail: string): AdsCheck => ({ check, result: 'PASSED', detail, fix: null });
const failed = (check: AdsCheckName, detail: string, fix: string): AdsCheck => ({ check, result: 'FAILED', detail, fix });
const warning = (check: AdsCheckName, detail: string, fix: string | null): AdsCheck => ({ check, result: 'WARNING', detail, fix });

const NEW_TOKEN =
  'In Meta Business Settings, open Users > System users, generate a token for the company app with the ads, pages and leads permissions, and paste it here.';

export function adsTokenChecks(token: { isValid: boolean; scopes: readonly string[]; expiresAt: number | null; error: string | null }, now: Date): AdsCheck[] {
  if (!token.isValid) return [failed('TOKEN_VALID', `Meta does not accept this token${token.error ? `: ${token.error}` : ''}.`, NEW_TOKEN)];
  const checks: AdsCheck[] = [passed('TOKEN_VALID', 'Meta accepts the token.')];
  const missingCore = ADS_CORE_PERMISSIONS.filter((p) => !token.scopes.includes(p));
  const missingParts = Object.keys(ADS_PART_PERMISSIONS).filter((p) => !token.scopes.includes(p));
  if (missingCore.length) {
    checks.push(failed('TOKEN_PERMISSIONS', `The token is missing ${missingCore.join(', ')}, which ads need.`, NEW_TOKEN));
  } else if (missingParts.length) {
    checks.push(
      warning('TOKEN_PERMISSIONS', `The token is missing ${missingParts.map((p) => `${p} (for ${ADS_PART_PERMISSIONS[p]})`).join(', ')}.`, NEW_TOKEN),
    );
  } else {
    checks.push(passed('TOKEN_PERMISSIONS', 'The token has every permission ads use.'));
  }
  const expiresAt = token.expiresAt;
  if (expiresAt === 0) checks.push(passed('TOKEN_EXPIRY', 'The token never expires.'));
  else if (expiresAt === null) checks.push(warning('TOKEN_EXPIRY', 'Meta did not say when the token expires.', 'Use a system user token that never expires.'));
  else if (expiresAt * 1000 <= now.getTime()) checks.push(failed('TOKEN_EXPIRY', 'The token has expired.', NEW_TOKEN));
  else checks.push(warning('TOKEN_EXPIRY', `The token expires on ${new Date(expiresAt * 1000).toISOString().slice(0, 10)}.`, 'Use a system user token that never expires.'));
  return checks;
}

const ACCOUNT_STATUS: Record<number, string> = {
  1: 'active',
  2: 'disabled',
  3: 'unsettled (a payment is due)',
  7: 'in risk review',
  8: 'pending settlement',
  9: 'in a grace period',
  100: 'about to close',
  101: 'closed',
};

const DISABLE_REASON: Record<number, string> = {
  1: 'ads integrity policy',
  2: 'intellectual property review',
  3: 'payment risk',
  4: 'account shut down',
  5: 'review of the account',
  6: 'business integrity review',
  7: 'permanently closed',
  8: 'unused reseller account',
  9: 'unused account',
};

export function adAccountChecks(account: { accountStatus: number; disableReason: number | null; hasPaymentMethod: boolean; currency: string; timezone: string }): AdsCheck[] {
  const checks: AdsCheck[] = [];
  const status = ACCOUNT_STATUS[account.accountStatus] ?? `status ${account.accountStatus}`;
  if (account.accountStatus === 1) checks.push(passed('AD_ACCOUNT_ACTIVE', 'The ad account is active.'));
  else if (account.accountStatus === 9) checks.push(warning('AD_ACCOUNT_ACTIVE', 'The ad account is in a grace period.', 'Settle the account balance in Meta Billing.'));
  else {
    const reason = account.disableReason ? ` (${DISABLE_REASON[account.disableReason] ?? `reason ${account.disableReason}`})` : '';
    checks.push(failed('AD_ACCOUNT_ACTIVE', `The ad account is ${status}${reason}.`, 'Fix the account in Meta Business Settings or Account Quality, then run the checks again.'));
  }
  checks.push(
    account.hasPaymentMethod
      ? passed('AD_ACCOUNT_PAYMENT', 'The ad account has a payment method.')
      : failed('AD_ACCOUNT_PAYMENT', 'The ad account has no payment method.', 'Add a payment method in Meta Billing.'),
  );
  checks.push(passed('AD_ACCOUNT_CURRENCY', `Amounts are in ${account.currency}; days follow ${account.timezone}.`));
  return checks;
}

export function pageChecks(page: { name: string; tasks: readonly string[]; whatsappNumbers: readonly string[] | null; leadTermsAccepted: boolean | null }): AdsCheck[] {
  const checks: AdsCheck[] = [];
  checks.push(
    page.tasks.includes('ADVERTISE')
      ? passed('PAGE_ADS', `Ads can run under ${page.name}.`)
      : failed('PAGE_ADS', `The token cannot run ads under ${page.name}.`, 'Give the system user the Advertise task on the page in Business Settings.'),
  );
  if (page.whatsappNumbers === null) {
    checks.push(warning('PAGE_WHATSAPP_NUMBERS', 'Meta did not say which WhatsApp numbers are linked to the page; Meta checks it when a chat ad is created.', null));
  } else if (!page.whatsappNumbers.length) {
    checks.push(warning('PAGE_WHATSAPP_NUMBERS', 'No WhatsApp number is linked to the page, so chat ads cannot run.', 'Link the WhatsApp number in the page settings (Linked accounts > WhatsApp).'));
  } else {
    checks.push(passed('PAGE_WHATSAPP_NUMBERS', `Linked WhatsApp numbers: ${page.whatsappNumbers.join(', ')}.`));
  }
  if (page.leadTermsAccepted === false) {
    checks.push(warning('LEAD_TERMS', "Meta's lead ads terms are not accepted for the page, so lead forms cannot be made.", 'Accept the lead ads terms for the page in Meta Business Suite.'));
  } else if (page.leadTermsAccepted) checks.push(passed('LEAD_TERMS', "Meta's lead ads terms are accepted."));
  return checks;
}

export function audienceTermsCheck(accepted: boolean | null): AdsCheck {
  if (accepted) return passed('AUDIENCE_TERMS', "Meta's customer list terms are accepted.");
  return warning(
    'AUDIENCE_TERMS',
    accepted === false ? "Meta's customer list terms are not accepted, so saved audiences cannot be made." : 'Meta did not say whether the customer list terms are accepted.',
    'Accept the custom audience terms for the ad account in Meta Ads Manager.',
  );
}

export function adsReady(checks: readonly AdsCheck[]): boolean {
  return !checks.some((c) => c.result === 'FAILED');
}

export function worstAdsCheck(checks: readonly AdsCheck[]): AdsCheck {
  const rank = { FAILED: 0, WARNING: 1, PASSED: 2 } as const;
  return [...checks].sort((a, b) => rank[a.result] - rank[b.result])[0]!;
}
