// Feature 010 (research R5, FR-011, FR-012): where a contact first came from. The kind is set once, when
// the contact is created; the label holds an import's label, a custom label or a chat link's name.

export const LEAD_SOURCE_KINDS = [
  'UNKNOWN',
  'ORGANIC',
  'API',
  'IMPORT',
  'CAMPAIGN_UPLOAD',
  'CHAT_LINK',
  'AD',
  'LEAD_FORM',
  'FORM',
  'WEBSITE_BUTTON',
  'STORE',
  'CUSTOM',
] as const;
export type LeadSourceKind = (typeof LEAD_SOURCE_KINDS)[number];

/** Names shown in the dashboard. */
export const LEAD_SOURCE_LABELS: Record<LeadSourceKind, string> = {
  UNKNOWN: 'Unknown',
  ORGANIC: 'Wrote to us first',
  API: 'API',
  IMPORT: 'Import',
  CAMPAIGN_UPLOAD: 'Campaign upload',
  CHAT_LINK: 'Chat link',
  AD: 'Ad',
  LEAD_FORM: 'Lead form',
  FORM: 'WhatsApp Form',
  WEBSITE_BUTTON: 'Website button',
  STORE: 'Store',
  CUSTOM: 'Custom',
};

/**
 * The kind and label for a lead source written as free text before feature 010 (the migration does the
 * same in SQL). Known words map to their kind; other text is CUSTOM with the text as its label.
 */
export function legacyLeadSource(text: string | null | undefined): { kind: LeadSourceKind; label: string | null } {
  const value = (text ?? '').trim();
  if (!value) return { kind: 'UNKNOWN', label: null };
  switch (value.toLowerCase()) {
    case 'organic':
      return { kind: 'ORGANIC', label: null };
    case 'api':
      return { kind: 'API', label: null };
    case 'import':
      return { kind: 'IMPORT', label: null };
    case 'campaign upload':
      return { kind: 'CAMPAIGN_UPLOAD', label: null };
    case 'store':
      return { kind: 'STORE', label: null };
    case 'lead form':
      return { kind: 'LEAD_FORM', label: null };
    default:
      return { kind: 'CUSTOM', label: value };
  }
}

/** How a contact's lead source reads in lists and exports, e.g. "Import · Expo leads". */
export function leadSourceText(kind: LeadSourceKind, label: string | null | undefined): string {
  const name = LEAD_SOURCE_LABELS[kind];
  return label ? (kind === 'CUSTOM' ? label : `${name} · ${label}`) : name;
}
