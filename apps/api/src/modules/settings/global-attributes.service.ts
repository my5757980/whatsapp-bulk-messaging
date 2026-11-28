import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import { AppError } from '../../common/errors/app-error.js';
import { isUniqueViolation } from '../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import type { GlobalAttribute } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';

// Feature 010 (US3, research R7, FR-014 – FR-016): company-wide values for template variables, chat
// replies, flow messages and AI agent instructions. Values are cached 30 seconds per process.

export const GLOBAL_KEY = /^[a-z][a-z0-9_]{0,39}$/;
export const GlobalAttributeCreateSchema = z
  .object({ key: z.string().regex(GLOBAL_KEY, 'use lower-case letters, digits and _'), description: z.string().trim().max(200).nullish(), value: z.string().max(1024) })
  .strict();
export const GlobalAttributeUpdateSchema = z.object({ description: z.string().trim().max(200).nullish(), value: z.string().max(1024) }).strict();
export type GlobalAttributeCreate = z.infer<typeof GlobalAttributeCreateSchema>;
export type GlobalAttributeUpdate = z.infer<typeof GlobalAttributeUpdateSchema>;

/** `{global:key}` in texts (saved replies, flows, AI agent instructions). */
export const GLOBAL_PLACEHOLDER = /\{global:([a-z][a-z0-9_]{0,39})\}/g;

/** Fills `{global:key}` placeholders; empty or unknown values are left out (never sent as a blank). */
export function fillGlobals(text: string, globals: Readonly<Record<string, string>>): string {
  return text.replace(GLOBAL_PLACEHOLDER, (_m, key: string) => globals[key] ?? '');
}

export interface GlobalUsage {
  kind: 'CAMPAIGN' | 'SAVED_REPLY' | 'FLOW' | 'AI_AGENT' | 'DATE_AUTOMATION' | 'KEYWORD_REPLY';
  id: string;
  name: string;
}

const CACHE_MS = 30_000;
type Row = GlobalAttribute & { updatedBy: { name: string | null } | null };

const toDto = (row: Row) => ({
  id: row.id,
  key: row.key,
  description: row.description,
  value: row.value,
  updatedBy: row.updatedBy?.name ?? null,
  updatedAt: row.updatedAt.toISOString(),
});

@Injectable()
export class GlobalAttributesService {
  private readonly logger = new Logger(GlobalAttributesService.name);
  private cache: { at: number; values: Record<string, string> } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Every global attribute's value by key (cached 30 seconds). */
  async values(): Promise<Record<string, string>> {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.values;
    const rows = await this.prisma.globalAttribute.findMany({ select: { key: true, value: true } });
    const values = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    this.cache = { at: Date.now(), values };
    return values;
  }

  /** Fills placeholders in a text, logging the keys that had no value. */
  async fill(text: string, where: string): Promise<string> {
    if (!text.includes('{global:')) return text;
    const globals = await this.values();
    const empty = [...text.matchAll(GLOBAL_PLACEHOLDER)].map((m) => m[1]!).filter((k) => !globals[k]);
    if (empty.length) this.logger.warn({ where, keys: [...new Set(empty)] }, 'Global attributes without a value were left out');
    return fillGlobals(text, globals);
  }

  async list() {
    const rows = await this.prisma.globalAttribute.findMany({ include: { updatedBy: { select: { name: true } } }, orderBy: { key: 'asc' } });
    return { items: rows.map(toDto) };
  }

  async create(input: GlobalAttributeCreate, actor: AuditActor) {
    try {
      const row = await this.prisma.globalAttribute.create({ data: { key: input.key, description: input.description ?? null, value: input.value, updatedById: actor.userId ?? null }, include: { updatedBy: { select: { name: true } } } });
      this.cache = null;
      await this.audit.record(actor, 'global_attribute.created', { type: 'global_attribute', id: row.id }, { key: row.key });
      return toDto(row);
    } catch (error) {
      if (isUniqueViolation(error)) throw AppError.conflict('Another global attribute has this name', 'KEY_TAKEN');
      throw error;
    }
  }

  async update(id: string, input: GlobalAttributeUpdate, actor: AuditActor) {
    const before = await this.prisma.globalAttribute.findUnique({ where: { id } });
    if (!before) throw AppError.notFound('Global attribute not found');
    const row = await this.prisma.globalAttribute.update({ where: { id }, data: { description: input.description ?? null, value: input.value, updatedById: actor.userId ?? null }, include: { updatedBy: { select: { name: true } } } });
    this.cache = null;
    await this.audit.record(actor, 'global_attribute.updated', { type: 'global_attribute', id }, { key: row.key, valueChanged: before.value !== row.value });
    return toDto(row);
  }

  async remove(id: string, actor: AuditActor): Promise<void> {
    const row = await this.prisma.globalAttribute.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Global attribute not found');
    const users = await this.usage(row.key);
    if (users.length) {
      throw new AppError(409, 'GLOBAL_ATTRIBUTE_IN_USE', 'This global attribute is still used', users.map((u) => ({ field: `${u.kind.toLowerCase()}.${u.id}`, issue: u.name })));
    }
    await this.prisma.globalAttribute.delete({ where: { id } });
    this.cache = null;
    await this.audit.record(actor, 'global_attribute.deleted', { type: 'global_attribute', id }, { key: row.key });
  }

  async usageOf(id: string) {
    const row = await this.prisma.globalAttribute.findUnique({ where: { id } });
    if (!row) throw AppError.notFound('Global attribute not found');
    return { items: await this.usage(row.key) };
  }

  /** Where a key is used: unfinished campaigns, saved replies, flows, AI agents, date automations, keyword replies. */
  async usage(key: string): Promise<GlobalUsage[]> {
    const placeholder = `%{global:${key}}%`;
    const [campaigns, replies, flows, agents, automations, settings] = await Promise.all([
      this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT c.id, c.name FROM campaigns c
         WHERE c.state IN ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED')
           AND EXISTS (SELECT 1 FROM jsonb_each(c.variable_mapping) e WHERE e.value ->> 'source' = 'global' AND e.value ->> 'key' = ${key})`,
      this.prisma.$queryRaw<Array<{ id: string; name: string }>>`SELECT id, name FROM canned_messages WHERE text LIKE ${placeholder}`,
      this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT f.id, f.name FROM flows f
         WHERE f.deleted_at IS NULL
           AND (f.draft::text LIKE ${placeholder} OR EXISTS (SELECT 1 FROM flow_versions v WHERE v.id = f.published_version_id AND v.graph::text LIKE ${placeholder}))`,
      this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT a.id, a.name FROM ai_agents a
         WHERE a.draft::text LIKE ${placeholder} OR EXISTS (SELECT 1 FROM ai_agent_versions v WHERE v.agent_id = a.id AND v.config::text LIKE ${placeholder})`,
      this.prisma.$queryRaw<Array<{ id: string; name: string }>>`
        SELECT d.id, d.name FROM date_automations d
         WHERE EXISTS (SELECT 1 FROM jsonb_each(d.variable_mapping) e WHERE e.value ->> 'source' = 'global' AND e.value ->> 'key' = ${key})`,
      this.prisma.$queryRaw<Array<{ id: number }>>`
        SELECT s.id FROM settings s
         WHERE EXISTS (SELECT 1 FROM jsonb_each(COALESCE(s.opt_out_reply -> 'variables', '{}'::jsonb) || COALESCE(s.opt_in_reply -> 'variables', '{}'::jsonb)) e
                        WHERE e.value ->> 'source' = 'global' AND e.value ->> 'key' = ${key})`,
    ]);
    return [
      ...campaigns.map((c) => ({ kind: 'CAMPAIGN' as const, id: c.id, name: c.name })),
      ...replies.map((r) => ({ kind: 'SAVED_REPLY' as const, id: r.id, name: r.name })),
      ...flows.map((f) => ({ kind: 'FLOW' as const, id: f.id, name: f.name })),
      ...agents.map((a) => ({ kind: 'AI_AGENT' as const, id: a.id, name: a.name })),
      ...automations.map((d) => ({ kind: 'DATE_AUTOMATION' as const, id: d.id, name: d.name })),
      ...settings.map(() => ({ kind: 'KEYWORD_REPLY' as const, id: 'settings', name: 'Keyword replies' })),
    ];
  }
}
