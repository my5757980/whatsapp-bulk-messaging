// Carts sent in chat (feature 008, research R11): the cart's own prices in minor units, names from the
// catalog copy, and warnings that stop automatic payment links. Pure.
import { formatMinor, toMinorUnits } from './money.js';

/** One item of an inbound order message (product_items[]). */
export interface CartItemInput {
  retailerId: string;
  quantity: number;
  /** Decimal in major units, as Meta sends it (verify). */
  itemPrice: number;
  currency: string;
}

export interface CartItem {
  retailerId: string;
  name: string | null;
  quantity: number;
  itemPriceMinor: number;
  currency: string;
}

export interface CatalogCopy {
  name: string;
  priceMinor: number | null;
  currency: string | null;
  removed: boolean;
}

export type CartWarningKind = 'NOT_IN_CATALOG' | 'CURRENCY' | 'MIXED_CURRENCY' | 'PRICE_CHANGED';

export interface CartWarning {
  kind: CartWarningKind;
  retailerId?: string;
  detail: string;
}

export interface Cart {
  items: CartItem[];
  currency: string;
  totalMinor: number;
  warnings: CartWarning[];
}

export function buildCart(input: readonly CartItemInput[], lookup: (retailerId: string) => CatalogCopy | undefined, accountCurrency: string): Cart {
  const account = accountCurrency.toLowerCase();
  const currency = (input[0]?.currency ?? account).toLowerCase();
  const warnings: CartWarning[] = [];
  const items: CartItem[] = input.map((raw) => {
    const itemCurrency = raw.currency.toLowerCase();
    const quantity = Number.isInteger(raw.quantity) && raw.quantity >= 1 ? raw.quantity : 1;
    const itemPriceMinor = toMinorUnits(raw.itemPrice, itemCurrency);
    const copy = lookup(raw.retailerId);
    if (!copy || copy.removed) {
      warnings.push({ kind: 'NOT_IN_CATALOG', retailerId: raw.retailerId, detail: `${raw.retailerId} is not in the catalog` });
    } else if (copy.priceMinor !== null && (copy.currency ?? itemCurrency).toLowerCase() === itemCurrency && copy.priceMinor !== itemPriceMinor) {
      warnings.push({
        kind: 'PRICE_CHANGED',
        retailerId: raw.retailerId,
        detail: `cart ${formatMinor(itemPriceMinor, itemCurrency)}, catalog ${formatMinor(copy.priceMinor, itemCurrency)}`,
      });
    }
    return { retailerId: raw.retailerId, name: copy?.name ?? null, quantity, itemPriceMinor, currency: itemCurrency };
  });
  if (items.some((item) => item.currency !== currency)) {
    warnings.push({ kind: 'MIXED_CURRENCY', detail: 'The cart has more than one currency' });
  }
  if (currency !== account) {
    warnings.push({ kind: 'CURRENCY', detail: `The cart is in ${currency.toUpperCase()}, payments are in ${account.toUpperCase()}` });
  }
  const totalMinor = items.filter((item) => item.currency === currency).reduce((sum, item) => sum + item.quantity * item.itemPriceMinor, 0);
  return { items, currency, totalMinor, warnings };
}
