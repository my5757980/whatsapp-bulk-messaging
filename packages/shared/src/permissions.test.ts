import { describe, expect, it } from 'vitest';
import { Role } from './enums.js';
import { ALL_PERMISSIONS, can, permissionsFor, type Permission } from './permissions.js';

// One row per line of the role table in spec.md (User Story 6).
const table: Array<[string, Permission[], { ADMIN: boolean; MANAGER: boolean; AGENT: boolean }]> = [
  ['connect/disconnect numbers, manage credentials', ['numbers.manage'], { ADMIN: true, MANAGER: false, AGENT: false }],
  ['invite/deactivate users, change roles', ['users.manage'], { ADMIN: true, MANAGER: false, AGENT: false }],
  ['API keys, rate card, keywords', ['apikeys.manage', 'ratecard.manage', 'settings.manage'], { ADMIN: true, MANAGER: false, AGENT: false }],
  ['manage contacts, tags, attributes; import', ['contacts.manage', 'attributes.manage'], { ADMIN: true, MANAGER: true, AGENT: false }],
  ['create/submit templates', ['templates.manage'], { ADMIN: true, MANAGER: true, AGENT: false }],
  ['create, schedule, launch, pause, cancel campaigns', ['campaigns.manage', 'campaigns.launch'], { ADMIN: true, MANAGER: true, AGENT: false }],
  ['view campaigns and reports', ['campaigns.view', 'templates.view', 'contacts.view'], { ADMIN: true, MANAGER: true, AGENT: true }],
  ['export data', ['data.export'], { ADMIN: true, MANAGER: true, AGENT: false }],
  ['view full phone numbers', ['phones.full'], { ADMIN: true, MANAGER: true, AGENT: false }],
  ['view audit log', ['audit.view'], { ADMIN: true, MANAGER: false, AGENT: false }],
  // Feature 002 live chat (spec FR-041)
  ['open live chat and History; intervene, reply, resolve, notes, block', ['inbox.view', 'inbox.reply'], { ADMIN: true, MANAGER: true, AGENT: true }],
  ['see and act on chats intervened by others; transfer any chat', ['inbox.monitor'], { ADMIN: true, MANAGER: true, AGENT: false }],
  ['create, edit and delete saved replies; remove library media', ['canned.manage', 'media.manage'], { ADMIN: true, MANAGER: true, AGENT: false }],
  ['working hours, automatic messages, keywords, auto-resolve, agent rules', ['livechat.settings'], { ADMIN: true, MANAGER: false, AGENT: false }],
  ['team view', ['inbox.metrics'], { ADMIN: true, MANAGER: true, AGENT: false }],
  // Feature 003 chatbot flows (spec FR-038); agents start published flows with inbox.reply
  ['build, test, publish and analyse chatbot flows; API-step secrets', ['flows.manage'], { ADMIN: true, MANAGER: true, AGENT: false }],
];

describe('permission matrix (spec.md role table)', () => {
  it.each(table)('%s', (_label, permissions, expected) => {
    for (const permission of permissions) {
      expect(can(Role.ADMIN, permission)).toBe(expected.ADMIN);
      expect(can(Role.MANAGER, permission)).toBe(expected.MANAGER);
      expect(can(Role.AGENT, permission)).toBe(expected.AGENT);
    }
  });

  it('admins hold every permission', () => {
    expect(permissionsFor(Role.ADMIN)).toEqual(expect.arrayContaining([...ALL_PERMISSIONS]));
  });

  it('agents view campaigns, contacts and templates, and work in live chat, with masked phones', () => {
    expect(permissionsFor(Role.AGENT).sort()).toEqual(['campaigns.view', 'contacts.view', 'inbox.reply', 'inbox.view', 'templates.view'].sort());
  });

  it('only admins may delete contact data', () => {
    expect(can(Role.ADMIN, 'contacts.delete')).toBe(true);
    expect(can(Role.MANAGER, 'contacts.delete')).toBe(false);
    expect(can(Role.AGENT, 'contacts.delete')).toBe(false);
  });

  it('unknown roles get nothing', () => {
    expect(can('GUEST' as Role, 'campaigns.view')).toBe(false);
  });
});
