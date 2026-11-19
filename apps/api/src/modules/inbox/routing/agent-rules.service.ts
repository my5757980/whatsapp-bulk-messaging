import { Body, Controller, Get, HttpStatus, Injectable, Param, ParseUUIDPipe, Put } from '@nestjs/common';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { CurrentUser, type RequestUser } from '../../../common/auth/request-user.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { AgentRulesLoader } from '../conversations/agent-rules.loader.js';

/** PUT /users/{id}/agent-rules: the whole set; an empty list removes the restriction. */
export const AgentRulesSchema = z
  .array(
    z.strictObject({
      kind: z.enum(['TAG', 'ATTRIBUTE']),
      tagId: z.uuid().optional(),
      attributeKey: z.string().trim().min(1).max(60).optional(),
      attributeValue: z.string().trim().min(1).max(200).optional(),
    }),
  )
  .max(50);
export type AgentRulesInput = z.infer<typeof AgentRulesSchema>;

export interface AgentRuleDto {
  id: string;
  kind: 'TAG' | 'ATTRIBUTE';
  tagId?: string;
  tagName: string | null;
  attributeKey?: string;
  attributeValue?: string;
}

/** Agent rules (T052, FR-028): an agent then sees only chats whose contact matches any rule. */
@Injectable()
export class AgentRulesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly loader: AgentRulesLoader,
  ) {}

  async list(userId: string): Promise<AgentRuleDto[]> {
    if (!(await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } }))) throw AppError.notFound('Member not found');
    const rows = await this.prisma.agentRule.findMany({ where: { userId }, include: { tag: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      ...(r.tagId ? { tagId: r.tagId } : {}),
      tagName: r.tag?.name ?? null,
      ...(r.attributeKey ? { attributeKey: r.attributeKey } : {}),
      ...(r.attributeValue ? { attributeValue: r.attributeValue } : {}),
    }));
  }

  async replace(userId: string, input: AgentRulesInput, actorId: string): Promise<AgentRuleDto[]> {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
    if (!user) throw AppError.notFound('Member not found');
    if (user.role !== 'AGENT') throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, 'NOT_AN_AGENT', 'Only agents can have agent rules');

    const details: Array<{ field: string; issue: string }> = [];
    const unique = new Map<string, { kind: 'TAG' | 'ATTRIBUTE'; tagId: string | null; attributeKey: string | null; attributeValue: string | null }>();
    const tagIds = input.flatMap((r) => (r.kind === 'TAG' && r.tagId ? [r.tagId] : []));
    const keys = input.flatMap((r) => (r.kind === 'ATTRIBUTE' && r.attributeKey ? [r.attributeKey] : []));
    const [tags, definitions] = await Promise.all([
      this.prisma.tag.findMany({ where: { id: { in: tagIds } }, select: { id: true } }),
      this.prisma.attributeDefinition.findMany({ where: { key: { in: keys } }, select: { key: true } }),
    ]);
    const knownTags = new Set(tags.map((t) => t.id));
    const knownKeys = new Set(definitions.map((d) => d.key));
    input.forEach((rule, i) => {
      if (rule.kind === 'TAG') {
        if (!rule.tagId || !knownTags.has(rule.tagId)) details.push({ field: `[${i}].tagId`, issue: 'is not an existing tag' });
        else unique.set(`TAG:${rule.tagId}`, { kind: 'TAG', tagId: rule.tagId, attributeKey: null, attributeValue: null });
      } else if (!rule.attributeKey || !knownKeys.has(rule.attributeKey)) {
        details.push({ field: `[${i}].attributeKey`, issue: 'is not a defined attribute' });
      } else if (!rule.attributeValue) {
        details.push({ field: `[${i}].attributeValue`, issue: 'is required' });
      } else {
        unique.set(`ATTRIBUTE:${rule.attributeKey}:${rule.attributeValue}`, { kind: 'ATTRIBUTE', tagId: null, attributeKey: rule.attributeKey, attributeValue: rule.attributeValue });
      }
    });
    if (details.length) throw AppError.validation('Some rules are not valid', details);

    await this.prisma.$transaction([
      this.prisma.agentRule.deleteMany({ where: { userId } }),
      this.prisma.agentRule.createMany({ data: [...unique.values()].map((r) => ({ ...r, userId, createdById: actorId })) }),
    ]);
    this.loader.invalidate(userId);
    return this.list(userId);
  }
}

/** GET/PUT /users/{id}/agent-rules (contracts/inbox-api.openapi.yaml), admins only. */
@Controller('users/:id/agent-rules')
export class AgentRulesController {
  constructor(private readonly rules: AgentRulesService) {}

  @Get()
  @Require('livechat.settings')
  list(@Param('id', ParseUUIDPipe) id: string) {
    return this.rules.list(id);
  }

  @Put()
  @Require('livechat.settings')
  replace(@Param('id', ParseUUIDPipe) id: string, @Body(new ZodValidationPipe(AgentRulesSchema)) body: AgentRulesInput, @CurrentUser() user: RequestUser) {
    return this.rules.replace(id, body, user.id);
  }
}
