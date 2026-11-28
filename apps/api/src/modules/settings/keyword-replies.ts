import { Body, Controller, Get, Inject, Injectable, Logger, Put, Req } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { Require } from '../../common/auth/permissions.guard.js';
import {
  CurrentUser,
  clientIp,
  type AuthedRequest,
  type RequestUser,
} from '../../common/auth/request-user.js';
import { AppError, type ErrorDetail } from '../../common/errors/app-error.js';
import { PrismaService } from '../../common/prisma/prisma.service.js';
import { REDIS_CLIENT } from '../../common/queue/queue.module.js';
import { ZodValidationPipe } from '../../common/validation/zod.pipe.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../audit/audit.service.js';
import {
  unmappedVariables,
  VariableMappingSchema,
  type VariableMapping,
} from '../campaigns/variable-resolver.js';
import { AutoRepliesService } from '../inbox/automation/auto-replies.service.js';
import { KEYWORD_REPLY_PARAM } from '../sending/template-payload.builder.js';

// Feature 010 (US4, research R8, FR-017, FR-018): the confirmation sent after an opt-out or opt-in keyword,
// a text or an approved utility template, at most once a day per contact and kind.

export const KeywordReplySchema = z
  .object({
    kind: z.enum(['NONE', 'TEXT', 'TEMPLATE']),
    text: z.string().trim().max(1024).nullish(),
    templateId: z.uuid().nullish(),
    variables: VariableMappingSchema.optional(),
  })
  .superRefine((reply, ctx) => {
    if (reply.kind === 'TEXT' && !reply.text)
      ctx.addIssue({ code: 'custom', path: ['text'], message: 'is required for a text reply' });
    if (reply.kind === 'TEMPLATE' && !reply.templateId)
      ctx.addIssue({
        code: 'custom',
        path: ['templateId'],
        message: 'is required for a template reply',
      });
  });
export const KeywordRepliesSchema = z
  .object({ optOut: KeywordReplySchema, optIn: KeywordReplySchema })
  .strict();
export type KeywordReplyInput = z.infer<typeof KeywordReplySchema>;
export type KeywordRepliesInput = z.infer<typeof KeywordRepliesSchema>;

export type KeywordReply =
  | { kind: 'NONE' }
  | { kind: 'TEXT'; text: string }
  | { kind: 'TEMPLATE'; templateId: string; variables: VariableMapping };
export type KeywordKind = 'OPT_OUT' | 'OPT_IN';

/** Once per contact and kind in 24 hours (R8). */
const ONCE_A_DAY_SECONDS = 86_400;
export const keywordReplyKey = (kind: KeywordKind, contactId: string) =>
  `wbm:kwreply:${kind.toLowerCase()}:${contactId}`;

/** A stored reply; anything unreadable counts as no reply. */
export function readKeywordReply(raw: unknown): KeywordReply {
  const parsed = KeywordReplySchema.safeParse(raw);
  if (!parsed.success) return { kind: 'NONE' };
  const r = parsed.data;
  if (r.kind === 'TEXT' && r.text) return { kind: 'TEXT', text: r.text };
  if (r.kind === 'TEMPLATE' && r.templateId)
    return { kind: 'TEMPLATE', templateId: r.templateId, variables: r.variables ?? {} };
  return { kind: 'NONE' };
}

const toDto = (r: KeywordReply) => ({
  kind: r.kind,
  text: r.kind === 'TEXT' ? r.text : null,
  templateId: r.kind === 'TEMPLATE' ? r.templateId : null,
  variables: r.kind === 'TEMPLATE' ? r.variables : {},
});

@Injectable()
export class KeywordRepliesService {
  private readonly logger = new Logger(KeywordRepliesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly autoReplies: AutoRepliesService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
  ) {}

  private async replies(): Promise<{ optOut: KeywordReply; optIn: KeywordReply }> {
    const row = await this.prisma.settings.upsert({
      where: { id: 1 },
      create: { id: 1 },
      update: {},
      select: { optOutReply: true, optInReply: true },
    });
    return { optOut: readKeywordReply(row.optOutReply), optIn: readKeywordReply(row.optInReply) };
  }

  async get() {
    const r = await this.replies();
    return { optOut: toDto(r.optOut), optIn: toDto(r.optIn) };
  }

  async update(input: KeywordRepliesInput, actor: AuditActor) {
    const optOut = readKeywordReply(input.optOut);
    const optIn = readKeywordReply(input.optIn);
    await this.checkTemplate(optOut, 'optOut');
    await this.checkTemplate(optIn, 'optIn');
    await this.prisma.settings.upsert({
      where: { id: 1 },
      create: {
        id: 1,
        optOutReply: optOut as Prisma.InputJsonValue,
        optInReply: optIn as Prisma.InputJsonValue,
      },
      update: {
        optOutReply: optOut as Prisma.InputJsonValue,
        optInReply: optIn as Prisma.InputJsonValue,
      },
    });
    await this.audit.record(
      actor,
      'keyword_replies.changed',
      { type: 'settings', id: '1' },
      { optOut: optOut.kind, optIn: optIn.kind },
    );
    return { optOut: toDto(optOut), optIn: toDto(optIn) };
  }

  /** Approved UTILITY templates only (checked on save and again before sending), every variable mapped. */
  private async checkTemplate(reply: KeywordReply, field: 'optOut' | 'optIn'): Promise<void> {
    if (reply.kind !== 'TEMPLATE') return;
    const template = await this.prisma.template.findUnique({
      where: { id: reply.templateId },
      select: { status: true, category: true, variables: true },
    });
    if (!template)
      throw AppError.validation('Choose an approved utility template', [
        { field: `${field}.templateId`, issue: 'was not found' },
      ]);
    if (template.category !== 'UTILITY') {
      throw AppError.validation(
        'Keyword replies can use utility templates only',
        [{ field: `${field}.templateId`, issue: 'is not a utility template' }],
        'TEMPLATE_NOT_UTILITY',
      );
    }
    if (template.status !== 'APPROVED')
      throw AppError.validation('Choose an approved utility template', [
        { field: `${field}.templateId`, issue: 'is not approved' },
      ]);
    const variables = (Array.isArray(template.variables) ? template.variables : []) as Array<{
      key: string;
    }>;
    const details: ErrorDetail[] = [
      ...unmappedVariables(variables, reply.variables).map((k) => ({
        field: `${field}.variables.${k}`,
        issue: 'needs a value',
      })),
      // No uploaded row or payment request exists for a keyword reply.
      ...Object.entries(reply.variables)
        .filter(([, s]) => s.source === 'column' || s.source === 'payment')
        .map(([k]) => ({
          field: `${field}.variables.${k}`,
          issue: 'use a contact field, an attribute, a global attribute or fixed text',
        })),
    ];
    if (details.length) throw AppError.validation('Map every template variable', details);
  }

  /**
   * Sends the confirmation in the chat the keyword came in, from that chat's number: never to blocked contacts,
   * never while the number's sending is off, and once per contact and kind in 24 hours.
   */
  async send(input: {
    conversationId: string;
    contactId: string;
    numberId: string;
    kind: KeywordKind;
  }): Promise<'SENT' | 'SKIPPED'> {
    const replies = await this.replies();
    const reply = input.kind === 'OPT_OUT' ? replies.optOut : replies.optIn;
    if (reply.kind === 'NONE') return 'SKIPPED';
    const [contact, number] = await Promise.all([
      this.prisma.contact.findUnique({
        where: { id: input.contactId },
        select: { blockedAt: true },
      }),
      this.prisma.whatsAppNumber.findUnique({
        where: { id: input.numberId },
        select: { sendingEnabled: true },
      }),
    ]);
    if (!contact || contact.blockedAt || !number?.sendingEnabled) return 'SKIPPED';
    if (reply.kind === 'TEMPLATE') {
      const template = await this.prisma.template.findUnique({
        where: { id: reply.templateId },
        select: { status: true, category: true },
      });
      if (template?.status !== 'APPROVED' || template.category !== 'UTILITY') {
        this.logger.warn(
          { kind: input.kind, templateId: reply.templateId },
          'Keyword reply template is no longer an approved utility template; not sent',
        );
        return 'SKIPPED';
      }
    }
    if (
      !(await this.redis.set(
        keywordReplyKey(input.kind, input.contactId),
        '1',
        'EX',
        ONCE_A_DAY_SECONDS,
        'NX',
      ))
    )
      return 'SKIPPED';
    try {
      if (reply.kind === 'TEXT')
        await this.autoReplies.sendContent(input.conversationId, {
          kind: 'TEXT',
          text: reply.text,
        });
      // The marker lets an opt-out confirmation reach the person who has just opted out (send processor).
      else
        await this.autoReplies.sendContent(
          input.conversationId,
          { kind: 'TEMPLATE', templateId: reply.templateId, variables: reply.variables },
          { [KEYWORD_REPLY_PARAM]: '1' },
        );
      return 'SENT';
    } catch (error) {
      this.logger.warn(
        { err: (error as Error).message, kind: input.kind, conversationId: input.conversationId },
        'Keyword reply not sent',
      );
      return 'SKIPPED';
    }
  }
}

/** /settings/keyword-replies (contracts/contacts-settings-api.openapi.yaml tag keyword-replies). */
@Controller('settings/keyword-replies')
export class KeywordRepliesController {
  constructor(private readonly replies: KeywordRepliesService) {}

  @Get()
  @Require('settings.view')
  get() {
    return this.replies.get();
  }

  @Put()
  @Require('settings.manage')
  update(
    @Body(new ZodValidationPipe(KeywordRepliesSchema)) body: KeywordRepliesInput,
    @CurrentUser() user: RequestUser,
    @Req() req: AuthedRequest,
  ) {
    return this.replies.update(body, { userId: user.id, ip: clientIp(req) ?? null });
  }
}
