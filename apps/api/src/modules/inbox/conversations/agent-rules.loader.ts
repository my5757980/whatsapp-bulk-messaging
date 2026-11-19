import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import type { AgentRuleFacts } from './visibility.js';

/** How long an agent's rules are reused; rule changes made on another instance apply within this time. */
export const AGENT_RULES_CACHE_MS = 30_000;

/** Loads an agent's rules (FR-028) with a short per-instance cache, used by lists, checks and live events. */
@Injectable()
export class AgentRulesLoader {
  private readonly cache = new Map<string, { rules: AgentRuleFacts[]; expires: number }>();

  constructor(private readonly prisma: PrismaService) {}

  async forUser(userId: string): Promise<AgentRuleFacts[]> {
    const hit = this.cache.get(userId);
    if (hit && hit.expires > Date.now()) return hit.rules;
    const rows = await this.prisma.agentRule.findMany({
      where: { userId },
      select: { kind: true, tagId: true, attributeKey: true, attributeValue: true },
      orderBy: { createdAt: 'asc' },
    });
    const rules: AgentRuleFacts[] = rows.map((r) => ({ kind: r.kind, tagId: r.tagId, attributeKey: r.attributeKey, attributeValue: r.attributeValue }));
    this.cache.set(userId, { rules, expires: Date.now() + AGENT_RULES_CACHE_MS });
    return rules;
  }

  /** Drops cached rules after a change on this instance (all users when no ID is given). */
  invalidate(userId?: string): void {
    if (userId) this.cache.delete(userId);
    else this.cache.clear();
  }
}
