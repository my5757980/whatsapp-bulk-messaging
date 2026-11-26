// The Meta catalog (feature 008, research R8, R10): reading Meta's price text, which products may be
// sent, and the limits of product messages. Pure.
import { toMinorUnits } from './money.js';

/** WhatsApp limits for commerce messages (Meta's messages reference; FLOW_LIMITS style). */
export const COMMERCE_LIMITS = {
  listSections: 10,
  listItems: 30,
  sectionTitle: 24,
  header: 60,
  body: 1024,
  footer: 60,
  /** cta_url button label (verify). */
  ctaDisplayText: 20,
  flowCta: 30,
  flowButtonText: 25,
} as const;

/**
 * Meta's price text ("AED 150.00", "1,234.50 AED", "د.إ.‏ 150.00", "$10.00") in minor units of
 * `currency`; null when there is nothing to read. Commas are thousands separators.
 */
export function parseCatalogPrice(text: string | null | undefined, currency: string | null | undefined): number | null {
  if (!text || !currency) return null;
  const cleaned = text
    .replace(/[\u200e\u200f\u00a0\u202f]/g, ' ')
    .replace(/[A-Za-z]{3}/g, ' ')
    .replace(/[^\d.,\s-]/g, ' ');
  const match = /\d[\d,]*(?:\.\d+)?/.exec(cleaned);
  if (!match) return null;
  const amount = Number(match[0].replace(/,/g, ''));
  return Number.isFinite(amount) && amount >= 0 ? toMinorUnits(amount, currency) : null;
}

export type NotSendableReason = 'OUT_OF_STOCK' | 'REMOVED' | 'REJECTED' | 'HIDDEN';

export interface SendableInput {
  availability: string | null;
  removedAt: Date | string | null;
  reviewStatus: string | null;
  visibility: string | null;
}

const SENDABLE_AVAILABILITY = new Set(['in stock', 'available for order']);
const normal = (value: string | null) => (value ?? '').toLowerCase().replace(/_/g, ' ').trim();

export function notSendableReason(product: SendableInput): NotSendableReason | null {
  if (product.removedAt) return 'REMOVED';
  if (normal(product.reviewStatus) === 'rejected') return 'REJECTED';
  if (normal(product.visibility) === 'staging' || normal(product.visibility) === 'hidden') return 'HIDDEN';
  if (!SENDABLE_AVAILABILITY.has(normal(product.availability))) return 'OUT_OF_STOCK';
  return null;
}

export function isSendableProduct(product: SendableInput): boolean {
  return notSendableReason(product) === null;
}

export interface ProductSection {
  title?: string;
  retailerIds: string[];
}

/** The limits of a product list (multi-product) message; null when it may be sent. */
export function productListProblem(sections: readonly ProductSection[]): string | null {
  if (sections.length < 1) return 'Add at least one section';
  if (sections.length > COMMERCE_LIMITS.listSections) return `A product list has at most ${COMMERCE_LIMITS.listSections} sections`;
  const all = sections.flatMap((s) => s.retailerIds);
  if (all.length > COMMERCE_LIMITS.listItems) return `A product list holds at most ${COMMERCE_LIMITS.listItems} products`;
  if (sections.some((s) => s.retailerIds.length === 0)) return 'Put at least one product in each section';
  if (new Set(all).size !== all.length) return 'A product is listed twice';
  if (sections.length > 1) {
    for (const section of sections) {
      const title = (section.title ?? '').trim();
      if (!title) return 'Each section needs a title when there are several';
      if ([...title].length > COMMERCE_LIMITS.sectionTitle) return `Section titles have at most ${COMMERCE_LIMITS.sectionTitle} characters`;
    }
  } else if ([...(sections[0]?.title ?? '')].length > COMMERCE_LIMITS.sectionTitle) {
    return `Section titles have at most ${COMMERCE_LIMITS.sectionTitle} characters`;
  }
  return null;
}
