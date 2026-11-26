// Graph `interactive` objects for reply buttons and lists sent by chatbot flows (feature 003,
// contracts/meta-graph-flows.md §1–2, T013). Pure: built from the chat item's text and payload.

interface ItemPayload {
  header?: string | null;
  footer?: string | null;
  buttons?: Array<{ id: string; title: string }>;
  buttonLabel?: string;
  sections?: Array<{ title?: string | null; rows?: Array<{ id: string; title: string; description?: string | null }> }>;
}

export type GraphInteractive =
  | {
      type: 'button';
      header?: { type: 'text'; text: string };
      body: { text: string };
      footer?: { text: string };
      action: { buttons: Array<{ type: 'reply'; reply: { id: string; title: string } }> };
    }
  | {
      type: 'list';
      header?: { type: 'text'; text: string };
      body: { text: string };
      footer?: { text: string };
      action: { button: string; sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }> };
    };

/** Feature 008: the Pay now message, an interactive cta_url with our pay link (contracts/meta-commerce-graph.md). */
export interface CtaUrlInteractive {
  type: 'cta_url';
  body: { text: string };
  action: { name: 'cta_url'; parameters: { display_text: string; url: string } };
}

/**
 * Feature 008 (R10): product messages from the chat item's payload: `product` (catalog and retailer
 * id), `product_list` (header, sections of product items) and `catalog_message` (optional thumbnail).
 */
export function commerceInteractiveFor(contentType: 'PRODUCT' | 'PRODUCT_LIST' | 'CATALOG', text: string | null, payload: unknown): Record<string, unknown> {
  const p = (payload ?? {}) as { catalogId?: string; retailerId?: string; header?: string; footer?: string; thumbnailRetailerId?: string | null; sections?: Array<{ title?: string | null; retailerIds?: string[] }> };
  const footer = p.footer ? { footer: { text: p.footer } } : {};
  if (contentType === 'PRODUCT') {
    return { type: 'product', ...(text ? { body: { text } } : {}), ...footer, action: { catalog_id: p.catalogId ?? '', product_retailer_id: p.retailerId ?? '' } };
  }
  if (contentType === 'PRODUCT_LIST') {
    return {
      type: 'product_list',
      header: { type: 'text', text: p.header ?? '' },
      body: { text: text ?? '' },
      ...footer,
      action: {
        catalog_id: p.catalogId ?? '',
        sections: (p.sections ?? []).map((s) => ({ ...(s.title ? { title: s.title } : {}), product_items: (s.retailerIds ?? []).map((id) => ({ product_retailer_id: id })) })),
      },
    };
  }
  return { type: 'catalog_message', body: { text: text ?? '' }, ...footer, action: { name: 'catalog_message', ...(p.thumbnailRetailerId ? { parameters: { thumbnail_product_retailer_id: p.thumbnailRetailerId } } : {}) } };
}

export function ctaUrlFor(text: string | null, payload: unknown): CtaUrlInteractive {
  const p = (payload ?? {}) as { buttonText?: string; url?: string };
  return { type: 'cta_url', body: { text: text ?? '' }, action: { name: 'cta_url', parameters: { display_text: p.buttonText ?? 'Pay now', url: p.url ?? '' } } };
}

export function interactiveFor(contentType: 'BUTTONS' | 'LIST', text: string | null, payload: unknown): GraphInteractive {
  const p = (payload ?? {}) as ItemPayload;
  const header = p.header ? { header: { type: 'text' as const, text: p.header } } : {};
  const footer = p.footer ? { footer: { text: p.footer } } : {};
  const body = { text: text ?? '' };
  if (contentType === 'BUTTONS') {
    return { type: 'button', ...header, body, ...footer, action: { buttons: (p.buttons ?? []).map((b) => ({ type: 'reply' as const, reply: { id: b.id, title: b.title } })) } };
  }
  return {
    type: 'list',
    ...header,
    body,
    ...footer,
    action: {
      button: p.buttonLabel ?? '',
      sections: (p.sections ?? []).map((section) => ({
        ...(section.title ? { title: section.title } : {}),
        rows: (section.rows ?? []).map((row) => ({ id: row.id, title: row.title, ...(row.description ? { description: row.description } : {}) })),
      })),
    },
  };
}
