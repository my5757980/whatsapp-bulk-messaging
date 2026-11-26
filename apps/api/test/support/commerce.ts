import { TokenCipher } from '../../src/common/crypto/token-cipher.js';
import type { Prisma } from '../../src/generated/prisma/client.js';
import { FAKE_CATALOG_ID } from './fake-commerce-graph.js';
import { STRIPE_TEST_KEY, STRIPE_WEBHOOK_SECRET } from './fake-stripe.js';
import { seedContact, seedNumber, uaePhone } from './fixtures.js';
import { webhook, type TestContext } from './test-context.js';

// Feature 008 test helpers (T018): a saved Stripe connection, payment settings, an open chat, the
// catalog copy, and inbound carts and form answers.

const cipher = () => new TokenCipher(process.env.TOKEN_ENCRYPTION_KEY as string);

/** Replaces any saved gateway with a working Stripe test connection (AED, notifications passed). */
export async function seedGateway(ctx: TestContext, overrides: Partial<Prisma.PaymentGatewayUncheckedCreateInput> = {}) {
  await ctx.prisma.paymentGateway.deleteMany();
  return ctx.prisma.paymentGateway.create({
    data: {
      provider: 'STRIPE',
      mode: 'TEST',
      accountId: 'acct_fake0001',
      accountName: 'Acme Trading',
      country: 'AE',
      currency: 'aed',
      secretKeyEnc: cipher().encrypt(STRIPE_TEST_KEY),
      keyKind: 'restricted',
      webhookSecretEnc: cipher().encrypt(STRIPE_WEBHOOK_SECRET),
      webhookEndpointId: 'we_test_existing',
      status: 'CONNECTED',
      checks: [],
      notificationCheck: { status: 'PASSED', passedAt: new Date().toISOString() },
      lastCheckedAt: new Date(),
      ...overrides,
    },
  });
}

/** The one settings row, with overrides (created with defaults when missing). */
export async function seedPaymentSettings(ctx: TestContext, overrides: Partial<Prisma.PaymentSettingsUncheckedCreateInput> = {}) {
  await ctx.prisma.paymentSettings.deleteMany();
  return ctx.prisma.paymentSettings.create({ data: { ...overrides } });
}

/** Removes every commerce row so a test file starts clean (files share one database). */
export async function clearCommerce(ctx: TestContext): Promise<void> {
  await ctx.prisma.$executeRawUnsafe(
    'TRUNCATE payment_events, payment_requests, chat_orders, form_answers, form_versions, forms, catalog_products, catalog_connections, payment_settings, payment_gateways CASCADE',
  );
}

/** A number, a contact and a conversation whose customer wrote `minutesAgo` minutes ago (window open by default). */
export async function seedOpenChat(ctx: TestContext, opts: { minutesAgo?: number; phone?: string; numberId?: string } = {}) {
  const number = opts.numberId ? await ctx.prisma.whatsAppNumber.findUniqueOrThrow({ where: { id: opts.numberId } }) : await seedNumber(ctx);
  const contact = await seedContact(ctx, opts.phone ?? uaePhone());
  const at = new Date(Date.now() - (opts.minutesAgo ?? 5) * 60_000);
  const conversation = await ctx.prisma.conversation.create({
    data: { contactId: contact.id, numberId: number.id, lastCustomerMessageAt: at, lastInboundAt: at, lastActivityAt: at },
  });
  return { number, contact, conversation };
}

/** The catalog connection and a copy of `count` products (shp-101 …), all sendable unless listed. */
export async function seedCatalog(ctx: TestContext, opts: { count?: number; outOfStock?: string[] } = {}) {
  await ctx.prisma.catalogConnection.deleteMany();
  await ctx.prisma.catalogProduct.deleteMany();
  const connection = await ctx.prisma.catalogConnection.create({ data: { catalogId: FAKE_CATALOG_ID, name: 'Fake Catalog', productCount: opts.count ?? 5, lastSyncedAt: new Date() } });
  const out = new Set(opts.outOfStock ?? []);
  for (let i = 1; i <= (opts.count ?? 5); i++) {
    const retailerId = `shp-${100 + i}`;
    await ctx.prisma.catalogProduct.create({
      data: { retailerId, metaProductId: `${7_000_000_000 + i}`, name: `Product ${100 + i}`, priceMinor: BigInt((50 + i) * 100), currency: 'aed', availability: out.has(retailerId) ? 'out of stock' : 'in stock', reviewStatus: 'approved', visibility: 'published' },
    });
  }
  return connection;
}

/** An inbound cart (order message) from `from` (digits, no plus). */
export function orderMessage(phoneNumberId: string, from: string, items: Array<{ retailerId: string; quantity: number; price: number }>, text?: string) {
  return webhook.inbound(phoneNumberId, from, '', {
    type: 'order',
    order: {
      catalog_id: FAKE_CATALOG_ID,
      ...(text ? { text } : {}),
      product_items: items.map((i) => ({ product_retailer_id: i.retailerId, quantity: i.quantity, item_price: i.price, currency: 'AED' })),
    },
  });
}

/** An inbound WhatsApp Form answer (nfm_reply) carrying `answers` and the flow token. */
export function formReply(phoneNumberId: string, from: string, answers: Record<string, unknown>) {
  return webhook.inbound(phoneNumberId, from, '', {
    type: 'interactive',
    interactive: { type: 'nfm_reply', nfm_reply: { name: 'flow', body: 'Sent', response_json: JSON.stringify(answers) } },
  });
}
