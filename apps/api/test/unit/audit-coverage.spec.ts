import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions.js';

// T175: every audited action of data-model.md §1 is recorded somewhere in the code base.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
/** Actions whose recording arrives with a later story (none since 003 US7). */
const PENDING_US7 = new Set<string>();

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === 'generated' ? [] : sources(full);
    return full.endsWith('.ts') && !full.endsWith('audit-actions.ts') ? [full] : [];
  });
}

describe('audit coverage', () => {
  const code = sources(SRC).map((file) => readFileSync(file, 'utf8')).join('\n');

  it('lists the actions from data-model.md', () => {
    expect(AUDIT_ACTIONS).toEqual([
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
      'flow.created',
      'flow.updated',
      'flow.duplicated',
      'flow.deleted',
      'flow.published',
      'flow.unpublished',
      'flow.restored',
      'flow.test_numbers_updated',
      'flow.secret_changed',
    ]);
  });

  it.each(AUDIT_ACTIONS.filter((a) => !PENDING_US7.has(a)))('%s is recorded by the code', (action) => {
    expect(code).toMatch(new RegExp(`['"\`]${action.replace('.', '\\.')}['"\`]`));
  });
});
