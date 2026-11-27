// The Stripe connection checks (feature 008, research R4), each PASSED, FAILED or WARNING with a
// plain fix. Pure: the api gathers the facts from Stripe. Our own wording.

export const STRIPE_KEY_PATTERN = /^(rk|sk)_(live|test)_[A-Za-z0-9]{10,}$/;
export const STRIPE_WEBHOOK_SECRET_PATTERN = /^whsec_[A-Za-z0-9]{10,}$/;

export const GATEWAY_CHECK_KEYS = ['KEY_FORMAT', 'KEY_KIND', 'ACCOUNT_READ', 'ACCOUNT_COUNTRY', 'ACCOUNT_CURRENCY', 'CHARGES_ENABLED', 'CHECKOUT_ACCESS', 'WEBHOOK_ENDPOINT'] as const;
export type GatewayCheckKey = (typeof GATEWAY_CHECK_KEYS)[number];
export type GatewayCheckResult = 'PASSED' | 'FAILED' | 'WARNING';

export interface GatewayCheck {
  check: GatewayCheckKey;
  result: GatewayCheckResult;
  detail: string;
  fix?: string;
}

export type StripeKeyKind = 'restricted' | 'secret';
export type GatewayMode = 'LIVE' | 'TEST';

export function keyInfo(key: string): { valid: boolean; kind: StripeKeyKind | null; mode: GatewayMode | null } {
  const match = STRIPE_KEY_PATTERN.exec(key.trim());
  if (!match) return { valid: false, kind: null, mode: null };
  return { valid: true, kind: match[1] === 'rk' ? 'restricted' : 'secret', mode: match[2] === 'live' ? 'LIVE' : 'TEST' };
}

type Failure = { ok: false; status: number; message: string };

export interface GatewayFacts {
  key: string;
  account:
    | { ok: true; name: string | null; country: string | null; currency: string | null; chargesEnabled: boolean; detailsSubmitted: boolean; currentlyDue: string[] }
    | Failure;
  checkout: { ok: true } | Failure;
  webhook: { mode: 'auto'; ok: true } | ({ mode: 'auto' } & Failure) | { mode: 'manual'; secretGiven: boolean };
}

const EXPECTED_COUNTRY = 'AE';
const EXPECTED_CURRENCY = 'aed';

export function gatewayChecks(facts: GatewayFacts): GatewayCheck[] {
  const info = keyInfo(facts.key);
  if (!info.valid) {
    return [{ check: 'KEY_FORMAT', result: 'FAILED', detail: 'This does not look like a Stripe secret or restricted key', fix: 'Copy the key from Stripe Dashboard → Developers → API keys (it starts with rk_ or sk_)' }];
  }
  const checks: GatewayCheck[] = [
    { check: 'KEY_FORMAT', result: 'PASSED', detail: info.mode === 'LIVE' ? 'Live key' : 'Test key: payments are not real' },
    info.kind === 'restricted'
      ? { check: 'KEY_KIND', result: 'PASSED', detail: 'Restricted key' }
      : {
          check: 'KEY_KIND',
          result: 'WARNING',
          detail: 'A secret key can do everything in your Stripe account',
          fix: 'Create a restricted key with Checkout Sessions: Write, Webhook Endpoints: Write and Events: Read, and use it instead',
        },
  ];

  const account = facts.account;
  if (account.ok) {
    checks.push({ check: 'ACCOUNT_READ', result: 'PASSED', detail: `Connected to ${account.name ?? 'your Stripe account'}` });
    const country = (account.country ?? '').toUpperCase();
    checks.push(
      country === EXPECTED_COUNTRY
        ? { check: 'ACCOUNT_COUNTRY', result: 'PASSED', detail: 'Account in the United Arab Emirates' }
        : { check: 'ACCOUNT_COUNTRY', result: 'WARNING', detail: `The account country is ${country || 'unknown'}; this platform is set up for the UAE`, fix: 'Check that this is the company’s UAE Stripe account' },
    );
    const currency = (account.currency ?? '').toLowerCase();
    checks.push(
      currency === EXPECTED_CURRENCY
        ? { check: 'ACCOUNT_CURRENCY', result: 'PASSED', detail: 'Payments in AED' }
        : { check: 'ACCOUNT_CURRENCY', result: 'WARNING', detail: `Payments will be in ${currency.toUpperCase() || 'an unknown currency'}`, fix: 'Set the account’s default currency in Stripe if this is not intended' },
    );
    checks.push(
      account.chargesEnabled
        ? { check: 'CHARGES_ENABLED', result: 'PASSED', detail: 'Stripe can take payments' }
        : {
            check: 'CHARGES_ENABLED',
            result: 'FAILED',
            detail: `Stripe cannot take payments yet${account.currentlyDue.length ? ` (missing: ${account.currentlyDue.join(', ')})` : ''}`,
            fix: 'Finish the account details Stripe asks for in the Dashboard, then run the checks again',
          },
    );
  } else if (account.status === 403) {
    checks.push({ check: 'ACCOUNT_READ', result: 'WARNING', detail: 'The key cannot read the account details', fix: 'Give the key read access to account details, or carry on if the other checks pass' });
  } else {
    checks.push({ check: 'ACCOUNT_READ', result: 'FAILED', detail: `Stripe did not answer (${account.status}): ${account.message}`, fix: 'Try again in a few minutes' });
  }

  const checkout = facts.checkout;
  checks.push(
    checkout.ok
      ? { check: 'CHECKOUT_ACCESS', result: 'PASSED', detail: 'The key can create payment pages' }
      : checkout.status === 403
        ? { check: 'CHECKOUT_ACCESS', result: 'FAILED', detail: 'The key may not create Checkout Sessions', fix: 'Give the key Checkout Sessions: Write' }
        : { check: 'CHECKOUT_ACCESS', result: 'FAILED', detail: `Stripe refused a test payment page (${checkout.status}): ${checkout.message}`, fix: 'Check the key and the account in Stripe, then run the checks again' },
  );

  const webhook = facts.webhook;
  if (webhook.mode === 'manual') {
    checks.push(
      webhook.secretGiven
        ? { check: 'WEBHOOK_ENDPOINT', result: 'PASSED', detail: 'Signing secret saved; run Test notifications' }
        : { check: 'WEBHOOK_ENDPOINT', result: 'FAILED', detail: 'No signing secret', fix: 'Add the notification address in Stripe and paste its signing secret (whsec_…)' },
    );
  } else if (webhook.ok) {
    checks.push({ check: 'WEBHOOK_ENDPOINT', result: 'PASSED', detail: 'Notification address registered in Stripe' });
  } else {
    checks.push({
      check: 'WEBHOOK_ENDPOINT',
      result: 'FAILED',
      detail: webhook.status === 403 ? 'The key may not register the notification address' : `Stripe refused the notification address (${webhook.status}): ${webhook.message}`,
      fix: 'Give the key Webhook Endpoints: Write, or add the address in Stripe yourself and paste its signing secret',
    });
  }
  return checks;
}

export function gatewayReady(checks: readonly GatewayCheck[]): boolean {
  return checks.length > 0 && !checks.some((c) => c.result === 'FAILED');
}
