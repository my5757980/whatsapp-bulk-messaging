import { describe, expect, it } from 'vitest';
import { API_KEY_SCOPES, DEFAULT_API_KEY_SCOPES, SCOPE_LABELS, effectiveScopes, hasScope, isApiKeyScope } from './scopes.js';

// T011 (feature 006, research R4, FR-010): API key permissions.
describe('API key scopes', () => {
  it('has the five scopes, with "send messages" alone for keys made before 006', () => {
    expect(API_KEY_SCOPES).toEqual(['messages.send', 'contacts.read', 'contacts.write', 'campaigns.trigger', 'drips.enrol', 'payments.read', 'payments.write']);
    expect(DEFAULT_API_KEY_SCOPES).toEqual(['messages.send']);
    for (const scope of API_KEY_SCOPES) expect(SCOPE_LABELS[scope]).toMatch(/\w/);
  });

  it('checks the scope a route needs', () => {
    expect(hasScope(['messages.send', 'contacts.read'], 'contacts.read')).toBe(true);
    expect(hasScope(['messages.send'], 'contacts.write')).toBe(false);
    // A key with no stored scopes behaves like a key made before 006.
    expect(hasScope(null, 'messages.send')).toBe(true);
    expect(hasScope([], 'contacts.read')).toBe(false);
    expect(effectiveScopes(undefined)).toEqual(['messages.send']);
  });

  it('ignores unknown scope names', () => {
    expect(isApiKeyScope('contacts.read')).toBe(true);
    expect(isApiKeyScope('contacts.delete')).toBe(false);
    expect(effectiveScopes(['contacts.read', 'everything'])).toEqual(['contacts.read']);
    expect(hasScope(['everything'], 'contacts.read')).toBe(false);
  });
});
