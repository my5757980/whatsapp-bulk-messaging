import type { CartWarningKind, NotSendableReason } from '@wbm/shared';

// Catalog and chat order types, query keys and labels (feature 008, T021;
// contracts/commerce-api.openapi.yaml).

export interface CatalogConnection {
  catalogId: string;
  name: string;
  syncStatus: 'IDLE' | 'RUNNING' | 'FAILED';
  lastSyncedAt: string | null;
  lastSyncError: string | null;
  productCount: number;
  fillEnabled: boolean;
  fillStoreId: string | null;
  lastFilledAt: string | null;
  fillErrors: Array<{ retailerId?: string; message: string }>;
}

export interface CommerceNumber {
  numberId: string;
  phone: string;
  wabaId: string;
  catalogConnected: boolean;
  cartEnabled: boolean | null;
  catalogVisible: boolean | null;
}

export interface CatalogState {
  connection: CatalogConnection | null;
  found: Array<{ wabaId: string; catalogs: Array<{ id: string; name: string }> }>;
  numbers: CommerceNumber[];
}

export interface CatalogProduct {
  retailerId: string;
  name: string;
  description: string | null;
  priceMinor: number | null;
  salePriceMinor: number | null;
  currency: string | null;
  imageUrl: string | null;
  availability: string;
  sendable: boolean;
  notSendableReason: NotSendableReason | null;
}

export type ProductMessageInput =
  | { kind: 'product'; retailerId: string; body?: string; footer?: string }
  | { kind: 'list'; header: string; body: string; footer?: string; sections: Array<{ title?: string; retailerIds: string[] }> }
  | { kind: 'catalog'; body: string; footer?: string; thumbnailRetailerId?: string };

export type ChatOrderStatus = 'RECEIVED' | 'LINK_SENT' | 'PAID' | 'EXPIRED' | 'CANCELLED' | 'REFUNDED';

export interface ChatOrder {
  id: string;
  contactId: string | null;
  conversationId: string | null;
  customerText: string | null;
  items: Array<{ retailerId: string; name: string | null; quantity: number; itemPriceMinor: number; currency: string }>;
  currency: string;
  totalMinor: number;
  warnings: Array<{ kind: CartWarningKind; retailerId?: string; detail?: string }>;
  mode: 'AUTO' | 'REVIEW' | 'FLOW';
  status: ChatOrderStatus;
  paymentRequestId: string | null;
  createdAt: string;
}

export const catalogKeys = {
  state: ['catalog', 'connection'] as const,
  products: (search: string, page: number, sendable?: boolean) => ['catalog', 'products', search, page, sendable ?? 'all'] as const,
  orders: (status: string, page: number) => ['chat-orders', status, page] as const,
  order: (id: string) => ['chat-orders', id] as const,
};

export const NOT_SENDABLE_LABEL: Record<NotSendableReason, string> = {
  OUT_OF_STOCK: 'Out of stock',
  REMOVED: 'No longer in the catalog',
  REJECTED: 'Rejected by Meta',
  HIDDEN: 'Hidden in the catalog',
};

export const CART_WARNING_LABEL: Record<CartWarningKind, string> = {
  NOT_IN_CATALOG: 'Not in the catalog',
  CURRENCY: 'Different currency',
  MIXED_CURRENCY: 'Mixed currencies',
  PRICE_CHANGED: 'Price changed',
};

export const CHAT_ORDER_STATUS_LABEL: Record<ChatOrderStatus, string> = {
  RECEIVED: 'Waiting for review',
  LINK_SENT: 'Payment link sent',
  PAID: 'Paid',
  EXPIRED: 'Not paid in time',
  CANCELLED: 'Cancelled',
  REFUNDED: 'Refunded',
};
