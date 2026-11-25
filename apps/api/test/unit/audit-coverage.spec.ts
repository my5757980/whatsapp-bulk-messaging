import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AUDIT_ACTIONS } from '../../src/modules/audit/audit-actions.js';

// T175: every audited action of data-model.md §1 is recorded somewhere in the code base.
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src');
/** Actions listed before the code that records them exists (feature 006 T014; each story removes its own). */
/** Actions listed before the code that records them exists (feature 007 T014; each story removes its own). */
const PENDING = new Set<string>([
  'ad_campaign.paused',
  'ad_campaign.resumed',
  'ad_campaign.ended',
  'ad_campaign.duplicated',
  'ad_audience.created',
  'ad_audience.deleted',
  'ad_lead_form.created',
  'ad_leads.exported',
]);

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
      'ai.agent_created',
      'ai.agent_updated',
      'ai.agent_duplicated',
      'ai.agent_deleted',
      'ai.agent_published',
      'ai.agent_unpublished',
      'ai.agent_restored',
      'ai.knowledge_added',
      'ai.knowledge_refreshed',
      'ai.knowledge_switched',
      'ai.knowledge_deleted',
      'ai.skills_changed',
      'ai.secret_changed',
      'ai.test_numbers_updated',
      'ai.number_agent_changed',
      'ai.limits_changed',
      'ai.assistant_action_confirmed',
      'campaign.retry_plan_changed',
      'campaign.retry_round_cancelled',
      'tracked_link.destination_changed',
      'drip.created',
      'drip.updated',
      'drip.activated',
      'drip.paused',
      'drip.resumed',
      'drip.archived',
      'drip.deleted',
      'drip.contacts_enrolled',
      'drip.contact_removed',
      'webhook_endpoint.created',
      'webhook_endpoint.updated',
      'webhook_endpoint.paused',
      'webhook_endpoint.resumed',
      'webhook_endpoint.deleted',
      'webhook_endpoint.secret_renewed',
      'webhook_delivery.resent',
      'api_key.scopes_changed',
      'store.connected',
      'store.updated',
      'store.disconnected',
      'store.consent_confirmed',
      'api_campaign.created',
      'api_campaign.updated',
      'api_campaign.live',
      'api_campaign.paused',
      'api_campaign.stopped',
      'store_automation.updated',
      'chat_link.created',
      'chat_link.updated',
      'chat_link.turned_off',
      'chat_link.deleted',
      'chat_link.contacts_tagged',
      'number.connected_with_wizard',
      'number.fixed_with_wizard',
      'ads.connected',
      'ads.disconnected',
      'ads.checks_run',
      'ads.spend_cap_changed',
      'ad_campaign.created',
      'ad_campaign.submitted',
      'ad_campaign.paused',
      'ad_campaign.resumed',
      'ad_campaign.ended',
      'ad_campaign.budget_changed',
      'ad_campaign.duplicated',
      'ad_audience.created',
      'ad_audience.deleted',
      'ad_lead_form.created',
      'ad_leads.exported',
    ]);
  });

  it.each(AUDIT_ACTIONS.filter((a) => !PENDING.has(a)))('%s is recorded by the code', (action) => {
    expect(code).toMatch(new RegExp(`['"\`]${action.replace('.', '\\.')}['"\`]`));
  });
});
