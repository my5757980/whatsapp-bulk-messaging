// API key permissions (feature 006, research R4, FR-010).

export const API_KEY_SCOPES = ['messages.send', 'contacts.read', 'contacts.write', 'campaigns.trigger', 'drips.enrol', 'payments.read', 'payments.write'] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Keys made before feature 006 can only send messages. */
export const DEFAULT_API_KEY_SCOPES: readonly ApiKeyScope[] = ['messages.send'];

export const SCOPE_LABELS: Record<ApiKeyScope, string> = {
  'messages.send': 'Send template messages',
  'contacts.read': 'Read contacts, tags and attributes',
  'contacts.write': 'Create and change contacts, tags and consent',
  'campaigns.trigger': 'Trigger API campaigns',
  'drips.enrol': 'Add contacts to drips and remove them',
  // Feature 008 (contracts/public-payments-v1.openapi.yaml)
  'payments.read': 'Read payment requests',
  'payments.write': 'Make, send and cancel payment requests',
};

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return typeof value === 'string' && (API_KEY_SCOPES as readonly string[]).includes(value);
}

/** A key's scopes: the stored known ones, or the default when none are stored. */
export function effectiveScopes(stored: readonly string[] | null | undefined): ApiKeyScope[] {
  if (stored === null || stored === undefined) return [...DEFAULT_API_KEY_SCOPES];
  return stored.filter(isApiKeyScope);
}

export function hasScope(stored: readonly string[] | null | undefined, needed: ApiKeyScope): boolean {
  return effectiveScopes(stored).includes(needed);
}
