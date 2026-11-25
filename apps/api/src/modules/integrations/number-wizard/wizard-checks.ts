import type { AppSubscription, TokenDebugInfo, WizardPhoneNumber } from '../../meta/meta-graph.client.js';

// The number connection wizard's checks (feature 006 US8, FR-051 - FR-055, research R13): each one is
// built from one documented Graph field or call, so a failure can name its fix in plain words.

export type WizardCheckName =
  | 'TOKEN_VALID'
  | 'TOKEN_PERMISSIONS'
  | 'TOKEN_EXPIRY'
  | 'NUMBER_REGISTERED'
  | 'TWO_STEP_PIN'
  | 'DISPLAY_NAME'
  | 'QUALITY'
  | 'MESSAGING_LIMIT'
  | 'APP_SUBSCRIBED'
  | 'WEBHOOK_CALLBACK'
  | 'TEST_MESSAGE';
export type WizardFixAction = 'REGISTER_NUMBER' | 'SUBSCRIBE_APP';

export interface WizardCheck {
  check: WizardCheckName;
  result: 'PASSED' | 'FAILED' | 'WARNING';
  detail: string;
  fix: string | null;
  fixAction: WizardFixAction | null;
}

export const REQUIRED_SCOPES = ['whatsapp_business_management', 'whatsapp_business_messaging'] as const;

const passed = (check: WizardCheckName, detail: string): WizardCheck => ({ check, result: 'PASSED', detail, fix: null, fixAction: null });
const failed = (check: WizardCheckName, detail: string, fix: string, fixAction: WizardFixAction | null = null): WizardCheck => ({ check, result: 'FAILED', detail, fix, fixAction });
const warning = (check: WizardCheckName, detail: string, fix: string | null): WizardCheck => ({ check, result: 'WARNING', detail, fix, fixAction: null });

const NEW_TOKEN =
  'In Meta Business Settings, open Users > System users, generate a token for the app with the permissions whatsapp_business_management and whatsapp_business_messaging, and paste it here.';

/** Validity, permissions and expiry of the pasted token. */
export function tokenChecks(debug: TokenDebugInfo, now: Date): WizardCheck[] {
  if (!debug.isValid) {
    return [failed('TOKEN_VALID', `Meta does not accept this token${debug.error ? `: ${debug.error}` : ''}.`, NEW_TOKEN)];
  }
  const checks: WizardCheck[] = [passed('TOKEN_VALID', 'Meta accepts the token.')];
  const missing = REQUIRED_SCOPES.filter((scope) => !debug.scopes.includes(scope));
  checks.push(
    missing.length
      ? failed('TOKEN_PERMISSIONS', `The token is missing the permission${missing.length > 1 ? 's' : ''} ${missing.join(' and ')}.`, NEW_TOKEN)
      : passed('TOKEN_PERMISSIONS', 'The token can manage the account and send messages.'),
  );
  const expiresAt = debug.expiresAt;
  if (expiresAt === 0) checks.push(passed('TOKEN_EXPIRY', 'The token never expires.'));
  else if (expiresAt === null) checks.push(warning('TOKEN_EXPIRY', 'Meta did not say when the token expires.', 'Use a system user token that never expires.'));
  else if (expiresAt * 1000 <= now.getTime()) checks.push(failed('TOKEN_EXPIRY', `The token expired on ${day(expiresAt)}.`, NEW_TOKEN));
  else
    checks.push(
      warning('TOKEN_EXPIRY', `The token expires on ${day(expiresAt)}; sending stops then.`, 'Use a system user token that never expires, so sending does not stop.'),
    );
  return checks;
}

/** The WhatsApp account ids the token may manage (its granular scopes). */
export function wabaIdsFrom(debug: TokenDebugInfo): string[] {
  return [...new Set(debug.granularScopes.filter((g) => g.scope === 'whatsapp_business_management').flatMap((g) => g.targetIds))];
}

/** Registration, two-step PIN, display name, quality and messaging limit of the chosen number. */
export function numberChecks(phone: WizardPhoneNumber): WizardCheck[] {
  const checks: WizardCheck[] = [];
  const verification = phone.codeVerificationStatus;
  if (verification === 'NOT_VERIFIED' || verification === 'EXPIRED') {
    checks.push(failed('NUMBER_REGISTERED', 'The number has not been verified with the code Meta sends.', 'In WhatsApp Manager, verify the number with the code Meta sends by text message or call.'));
  } else if (phone.platformType === 'CLOUD_API') {
    checks.push(passed('NUMBER_REGISTERED', 'The number is registered for sending through the Cloud API.'));
  } else if (phone.platformType === 'ON_PREMISE') {
    checks.push(failed('NUMBER_REGISTERED', 'The number uses the On-Premises API.', 'Move the number to the Cloud API in WhatsApp Manager, then run the checks again.'));
  } else if (phone.platformType === 'NOT_APPLICABLE') {
    checks.push(failed('NUMBER_REGISTERED', 'The number is not registered for sending yet.', "Register it here with the number's 6-digit two-step verification PIN.", 'REGISTER_NUMBER'));
  } else {
    checks.push(warning('NUMBER_REGISTERED', 'Meta did not say how the number is registered.', 'Check the number in WhatsApp Manager.'));
  }
  checks.push(
    phone.platformType === 'CLOUD_API'
      ? passed('TWO_STEP_PIN', 'Two-step verification is set (registering needs it).')
      : warning(
          'TWO_STEP_PIN',
          'Registering needs a 6-digit two-step verification PIN.',
          'Use the PIN the number already has. If it has none, the PIN you enter becomes its new PIN; keep it safe.',
        ),
  );
  checks.push(displayNameCheck(phone));
  checks.push(qualityCheck(phone.qualityRating));
  checks.push(limitCheck(phone.messagingLimit));
  return checks;
}

function displayNameCheck(phone: WizardPhoneNumber): WizardCheck {
  const name = phone.verifiedName ? `"${phone.verifiedName}"` : 'The display name';
  switch (phone.nameStatus) {
    case 'APPROVED':
    case 'AVAILABLE_WITHOUT_REVIEW':
      return passed('DISPLAY_NAME', `${name} is approved.`);
    case 'PENDING_REVIEW':
      return warning('DISPLAY_NAME', `${name} is waiting for Meta's review.`, 'Wait for the review; Meta usually answers within a few days.');
    case 'DECLINED':
    case 'EXPIRED':
    case 'NON_EXISTS':
      return failed(
        'DISPLAY_NAME',
        `${name} ${phone.nameStatus === 'DECLINED' ? 'was declined' : phone.nameStatus === 'EXPIRED' ? 'has expired' : 'is not set'}.`,
        'In WhatsApp Manager, set a display name that matches your business, then wait for the review.',
      );
    default:
      return warning('DISPLAY_NAME', 'Meta did not say whether the display name is approved.', 'Check the display name in WhatsApp Manager.');
  }
}

function qualityCheck(rating: string | null): WizardCheck {
  switch (rating) {
    case 'GREEN':
      return passed('QUALITY', 'Quality is high.');
    case 'YELLOW':
      return warning('QUALITY', 'Quality is medium.', 'Send only to people who opted in, and stop messages that get blocked or reported.');
    case 'RED':
      return warning('QUALITY', 'Quality is low; Meta may lower the messaging limit.', 'Pause marketing, send only to people who opted in, and improve messages that get blocked or reported.');
    default:
      return passed('QUALITY', 'No quality rating yet (usual for a new number).');
  }
}

const LIMITS: Record<string, string> = {
  TIER_50: '50',
  TIER_250: '250',
  TIER_1K: '1,000',
  TIER_2K: '2,000',
  TIER_10K: '10,000',
  TIER_100K: '100,000',
  TIER_UNLIMITED: 'unlimited',
};

function limitCheck(limit: string | null): WizardCheck {
  if (!limit) return warning('MESSAGING_LIMIT', 'Meta did not return a messaging limit.', 'Check the limit of your business portfolio in WhatsApp Manager.');
  const amount = LIMITS[limit];
  if (!amount) return passed('MESSAGING_LIMIT', `Messaging limit: ${limit}.`);
  if (limit === 'TIER_50' || limit === 'TIER_250') {
    return warning('MESSAGING_LIMIT', `New customers a day: ${amount}.`, 'Verify your business in Meta Business Settings to raise the limit.');
  }
  return passed('MESSAGING_LIMIT', amount === 'unlimited' ? 'New customers a day: unlimited.' : `New customers a day: ${amount}.`);
}

/** The account's app subscription and the app's webhook callback (FR-052). */
export function appChecks(input: {
  appId: string | null;
  subscribedApps: Array<{ id: string; name: string | null }> | null;
  subscriptions: AppSubscription[] | null;
  expectedCallback: string;
}): WizardCheck[] {
  const checks: WizardCheck[] = [];
  const apps = input.subscribedApps;
  if (apps === null) {
    checks.push(warning('APP_SUBSCRIBED', 'Could not read the apps that get this account’s webhooks.', 'Run the checks again in a minute.'));
  } else if (input.appId ? apps.some((a) => a.id === input.appId) : apps.length > 0) {
    checks.push(passed('APP_SUBSCRIBED', input.appId ? 'The account sends its webhooks to the company’s app.' : `The account sends its webhooks to ${apps.map((a) => a.name ?? a.id).join(', ')}.`));
  } else {
    checks.push(failed('APP_SUBSCRIBED', 'The account does not send its webhooks to the company’s app, so replies and statuses would not arrive.', 'Subscribe the account to the app here.', 'SUBSCRIBE_APP'));
  }
  const subscription = input.subscriptions?.find((s) => s.object === 'whatsapp_business_account');
  const setIt = `In the Meta app dashboard, open WhatsApp > Configuration, set the callback URL to ${input.expectedCallback} and subscribe to the messages field.`;
  if (!input.appId || input.subscriptions === null) {
    checks.push(warning('WEBHOOK_CALLBACK', 'The app’s webhook address could not be read here; the test message checks it.', null));
  } else if (!subscription || !subscription.active) {
    checks.push(failed('WEBHOOK_CALLBACK', 'The app has no webhook for WhatsApp accounts.', setIt));
  } else if (subscription.callbackUrl !== input.expectedCallback) {
    checks.push(failed('WEBHOOK_CALLBACK', `The app sends webhooks to ${subscription.callbackUrl ?? 'no address'}.`, setIt));
  } else if (!subscription.fields.includes('messages')) {
    checks.push(failed('WEBHOOK_CALLBACK', 'The app webhook does not include the messages field.', setIt));
  } else {
    checks.push(passed('WEBHOOK_CALLBACK', 'The app sends webhooks to this platform.'));
  }
  return checks;
}

export function testMessageCheck(result: { sent: boolean; delivered: boolean; error: string | null }): WizardCheck {
  if (!result.sent) return failed('TEST_MESSAGE', `The test message was not sent${result.error ? `: ${result.error}` : '.'}`, 'Fix the failed checks above, then send it again.');
  if (!result.delivered) {
    return failed('TEST_MESSAGE', 'The test message was sent, but no delivered status arrived within 60 seconds.', 'Check the webhook address and the app subscription above, then send it again.');
  }
  return passed('TEST_MESSAGE', 'The test message was delivered and its status arrived.');
}

/** Ready to connect when no check failed. */
export function isReady(checks: readonly WizardCheck[]): boolean {
  return !checks.some((c) => c.result === 'FAILED');
}

/** The token check shown first in the wizard: the most serious of the token checks. */
export function worstOf(checks: readonly WizardCheck[]): WizardCheck {
  const rank = { FAILED: 0, WARNING: 1, PASSED: 2 } as const;
  return [...checks].sort((a, b) => rank[a.result] - rank[b.result])[0]!;
}

function day(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}
