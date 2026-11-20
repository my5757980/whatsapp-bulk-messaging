// Audited actions (data-model.md §1, FR-008, T175). The unit test audit-coverage.spec.ts checks
// that each one is recorded somewhere in the code base; keep this list in sync with the data model.

export const AUDIT_ACTIONS = [
  'auth.login',
  'auth.login_failed',
  'auth.logout',
  'user.invited',
  'user.role_changed',
  'user.deactivated',
  'user.reactivated',
  'number.connected',
  'number.disconnected',
  'number.credentials_changed',
  'campaign.launched',
  'campaign.scheduled',
  'campaign.paused',
  'campaign.auto_paused',
  'campaign.resumed',
  'campaign.cancelled',
  'data.exported',
  'contact.deleted',
  'api_key.created',
  'api_key.revoked',
  'settings.updated',
  'rate_card.updated',
  // Live chat (feature 002, FR-040). Message content is never copied into the metadata.
  'inbox.intervened',
  'inbox.transferred',
  'inbox.resolved',
  'contact.blocked',
  'contact.unblocked',
  'canned.created',
  'canned.updated',
  'canned.deleted',
  'media.removed',
  'livechat.settings_updated',
  'agent_rules.updated',
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];
