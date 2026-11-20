import { can, type Role } from '@wbm/shared';
import { Prisma } from '../../../generated/prisma/client.js';
import type { ConversationState } from '../inbox-common.js';

// Who may see which chat (FR-026-FR-028, research R7). One rule set serves REST lists (SQL),
// single-chat checks and live-event filtering (in memory); an integration test keeps both in step.

export interface Viewer {
  id: string;
  role: Role;
}

/** An agent rule (agent_rules); an agent matches a contact when any rule matches. */
export interface AgentRuleFacts {
  kind: 'TAG' | 'ATTRIBUTE';
  tagId: string | null;
  attributeKey: string | null;
  attributeValue: string | null;
}

export interface ChatFacts {
  state: ConversationState;
  intervenedById: string | null;
  blocked: boolean;
  contactTagIds: readonly string[];
  contactAttributes: Record<string, unknown>;
}

/** Admins and managers see every chat, including chats other members took. */
export function seesAll(viewer: Viewer): boolean {
  return can(viewer.role, 'inbox.monitor');
}

/** An attribute value as Postgres `->>` renders it; null never matches. */
export function attributeText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

/** True when the agent has no rules, or any rule matches the contact. */
export function matchesRules(rules: readonly AgentRuleFacts[], facts: Pick<ChatFacts, 'contactTagIds' | 'contactAttributes'>): boolean {
  if (rules.length === 0) return true;
  return rules.some((rule) =>
    rule.kind === 'TAG'
      ? rule.tagId !== null && facts.contactTagIds.includes(rule.tagId)
      : rule.attributeKey !== null && rule.attributeValue !== null && attributeText(facts.contactAttributes[rule.attributeKey]) === rule.attributeValue,
  );
}

/** May the viewer open the chat? Agents: open or waiting chats matching their rules, plus their own. */
export function canAccess(viewer: Viewer, rules: readonly AgentRuleFacts[], facts: ChatFacts): boolean {
  if (seesAll(viewer)) return true;
  if (facts.state === 'INTERVENED') return facts.intervenedById === viewer.id;
  return matchesRules(rules, facts);
}

/** Live lists and live events also hide blocked contacts, for everyone (FR-034). */
export function canSeeLive(viewer: Viewer, rules: readonly AgentRuleFacts[], facts: ChatFacts): boolean {
  return !facts.blocked && canAccess(viewer, rules, facts);
}

/**
 * The same rule as a SQL condition for list queries. `aliases` name the conversations table and a
 * LEFT JOINed contacts table. Every rule value is a bound parameter.
 */
export function visibleSql(viewer: Viewer, rules: readonly AgentRuleFacts[], aliases: { conversation: string; contact: string }): Prisma.Sql {
  if (seesAll(viewer)) return Prisma.sql`TRUE`;
  const c = Prisma.raw(aliases.conversation);
  return Prisma.sql`((${c}.state IN ('ACTIVE'::"ConversationState", 'REQUESTING'::"ConversationState") AND ${rulesSql(rules, aliases)}) OR ${c}.intervened_by_id = ${viewer.id}::uuid)`;
}

function rulesSql(rules: readonly AgentRuleFacts[], aliases: { conversation: string; contact: string }): Prisma.Sql {
  if (rules.length === 0) return Prisma.sql`TRUE`;
  const c = Prisma.raw(aliases.conversation);
  const k = Prisma.raw(aliases.contact);
  const parts: Prisma.Sql[] = [];
  const tagIds = rules.flatMap((rule) => (rule.kind === 'TAG' && rule.tagId ? [rule.tagId] : []));
  if (tagIds.length) {
    parts.push(Prisma.sql`EXISTS (SELECT 1 FROM contact_tags ct WHERE ct.contact_id = ${c}.contact_id AND ct.tag_id = ANY(${tagIds}::uuid[]))`);
  }
  for (const rule of rules) {
    if (rule.kind === 'ATTRIBUTE' && rule.attributeKey !== null && rule.attributeValue !== null) {
      parts.push(Prisma.sql`(${k}.attributes ->> ${rule.attributeKey}) = ${rule.attributeValue}`);
    }
  }
  return parts.length ? Prisma.sql`(${Prisma.join(parts, ' OR ')})` : Prisma.sql`FALSE`;
}
