import { expect, type Page } from '@playwright/test';
import { LINK_BASE, csrfHeaders } from './growth-helpers';

// Feature 008 e2e helpers: the mock Stripe keys (tools/mock-meta/src/stripe.ts), a connected gateway,
// and the mock gateway's control routes.

export const MOCK_META_URL = process.env.MOCK_META_URL ?? 'http://localhost:4010';
export const STRIPE_KEY_OK = 'rk_test_mockOK1234';
export const STRIPE_KEY_NO_PERMS = 'rk_test_mockOKnoperm';
export const STRIPE_KEY_REJECTED = 'rk_test_mockXXnockout';
/** A live-mode mock key: its payments count in totals (test payments are left out, FR-005). */
export const STRIPE_KEY_LIVE = 'rk_live_mockOK1234';

export interface RequestRow {
  id: string;
  phone: string | null;
  status: string;
  payUrl: string;
  source: string;
  amountMinor: number;
}

/** Payment requests (test ones too) matching a query string. */
export async function requests(page: Page, query: string): Promise<RequestRow[]> {
  const res = await page.request.get(`/api/payments/requests?includeTest=true&pageSize=200&${query}`);
  expect(res.ok()).toBe(true);
  return ((await res.json()) as { items: RequestRow[] }).items;
}

/** A utility template whose URL button is our pay link, approved by mock-meta. */
export async function createPayLinkTemplate(page: Page, wabaId: string, name: string): Promise<string> {
  const res = await page.request.post('/api/templates', {
    headers: await csrfHeaders(page),
    data: {
      wabaId,
      name,
      language: 'en_US',
      category: 'UTILITY',
      body: { text: 'Hi {{1}}, your invoice comes to {{2}}.', examples: ['Sara', 'AED 99.00'] },
      buttons: [{ type: 'URL', text: 'Pay now', url: `${LINK_BASE}/p/{{1}}`, urlExample: `${LINK_BASE}/p/AbCdEf1234` }],
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  const id = ((await res.json()) as { id: string }).id;
  await expect
    .poll(async () => ((await (await page.request.get(`/api/templates/${id}`)).json()) as { status: string }).status, { timeout: 45_000 })
    .toBe('APPROVED');
  return id;
}

/** Connects the mock Stripe account with this key (disconnecting first), with automatic registration. */
export async function connectStripe(page: Page, secretKey: string): Promise<void> {
  await page.request.delete('/api/payments/gateway', { headers: await csrfHeaders(page) });
  const res = await page.request.put('/api/payments/gateway', { headers: await csrfHeaders(page), data: { secretKey, registerEndpoint: true } });
  if (!res.ok()) throw new Error(`connecting Stripe failed: ${res.status()} ${await res.text()}`);
}

/** Connects the mock Stripe account with automatic registration, unless already connected. */
export async function ensureStripeConnected(page: Page): Promise<void> {
  const current = await page.request.get('/api/payments/gateway');
  const body = (await current.json()) as { gateway: { status: string } | null };
  if (body.gateway?.status === 'CONNECTED') return;
  const res = await page.request.put('/api/payments/gateway', { headers: await csrfHeaders(page), data: { secretKey: STRIPE_KEY_OK, registerEndpoint: true } });
  if (!res.ok()) throw new Error(`connecting Stripe failed: ${res.status()} ${await res.text()}`);
}

interface MockSession {
  id: string;
  status: string;
  payment_status: string;
  amount_total: number;
  metadata: Record<string, string>;
}

/** The mock gateway's sessions, newest last. */
export async function mockSessions(page: Page): Promise<MockSession[]> {
  const res = await page.request.get(`${MOCK_META_URL}/mock/stripe/sessions`);
  return ((await res.json()) as { data: MockSession[] }).data;
}

/** The newest session made for a payment request. */
export async function sessionFor(page: Page, requestId: string): Promise<MockSession | undefined> {
  return (await mockSessions(page)).filter((s) => s.metadata.wbm_payment_request === requestId).at(-1);
}

/** Pays a session without the hosted page (it still sends the signed event). */
export async function payMockSession(page: Page, sessionId: string): Promise<void> {
  const res = await page.request.post(`${MOCK_META_URL}/mock/stripe/pay`, { data: { sessionId } });
  if (!res.ok()) throw new Error(`mock payment failed: ${res.status()}`);
}

export async function refundMockSession(page: Page, sessionId: string, amount: number): Promise<void> {
  const res = await page.request.post(`${MOCK_META_URL}/mock/stripe/refund`, { data: { sessionId, amount } });
  if (!res.ok()) throw new Error(`mock refund failed: ${res.status()}`);
}
