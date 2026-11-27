import { z } from 'zod';
import type { Prisma, Template } from '../../generated/prisma/client.js';

// Campaign payment requests (feature 008 US3, FR-009, research R5): a campaign may ask every recipient
// to pay. The config lives on the campaign; the payments module makes the requests through this port,
// so campaigns never import payments (as flows use FLOW_PAYMENTS).

export const CampaignPaymentConfigSchema = z
  .object({
    amount: z.discriminatedUnion('source', [
      z.object({ source: z.literal('static'), minor: z.number().int().min(1).max(10_000_000_000) }).strict(),
      z.object({ source: z.literal('attribute'), attributeKey: z.string().trim().min(1).max(60) }).strict(),
    ]),
    /** What the payment is for; `{name}` and `{attr:key}` are filled per recipient. */
    description: z.string().trim().min(1).max(250),
    expiryMinutes: z.number().int().min(30).max(43_200),
    tagId: z.uuid().nullable().optional(),
    flowId: z.uuid().nullable().optional(),
  })
  .strict();
export type CampaignPaymentConfig = z.infer<typeof CampaignPaymentConfigSchema>;

/** What the recipient snapshot needs to give each recipient a request. */
export interface CampaignPaymentContext {
  currency: string;
  maxAmountMinor: number;
  /** The template's pay link button, whose suffix carries the request's code. */
  buttonIndex: number;
  linkBase: string;
  timeZone: string;
  livemode: boolean;
}

/** One recipient's request, decided in the snapshot and made in the launch transaction. */
export interface RecipientPayment {
  code: string;
  amountMinor: number;
  description: string;
  expiresAt: Date;
}

export interface CampaignPaymentRecipient {
  messageId: string;
  contactId: string;
  phoneE164: string;
  customerName: string | null;
  payment: RecipientPayment;
}

export const CAMPAIGN_PAYMENTS = Symbol('CAMPAIGN_PAYMENTS');

export interface CampaignPaymentsPort {
  /** Throws when the campaign cannot ask for payments (Stripe not ready, no pay link button). */
  context(template: Pick<Template, 'components'>): Promise<CampaignPaymentContext>;
  /** The recipients' requests, in the launch transaction; their sessions are made when first opened. */
  createMany(tx: Prisma.TransactionClient, campaign: { id: string; config: CampaignPaymentConfig; context: CampaignPaymentContext }, recipients: CampaignPaymentRecipient[]): Promise<void>;
}

/** The config stored on a campaign, or null when it asks for no payment (or the stored value is bad). */
export function campaignPaymentConfig(value: unknown): CampaignPaymentConfig | null {
  if (value === null || value === undefined) return null;
  const parsed = CampaignPaymentConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
