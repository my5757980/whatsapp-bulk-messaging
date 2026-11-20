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
