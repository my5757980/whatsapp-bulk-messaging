import type { Page } from '@playwright/test';
import { csrfHeaders } from './growth-helpers';

// Feature 008 e2e helpers: the mock Stripe keys (tools/mock-meta/src/stripe.ts), a connected gateway,
// and the mock gateway's control routes.

export const MOCK_META_URL = process.env.MOCK_META_URL ?? 'http://localhost:4010';
export const STRIPE_KEY_OK = 'rk_test_mockOK1234';
export const STRIPE_KEY_NO_PERMS = 'rk_test_mockOKnoperm';
export const STRIPE_KEY_REJECTED = 'rk_test_mockXXnockout';

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
