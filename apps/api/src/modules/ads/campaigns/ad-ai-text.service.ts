import { Body, Controller, HttpCode, HttpStatus, Injectable, Post } from '@nestjs/common';
import { AD_GOALS, AD_TEXT_LIMITS, AD_TEXT_RECOMMENDED, type AdGoal } from '@wbm/shared';
import { z } from 'zod';
import { Require } from '../../../common/auth/permissions.guard.js';
import { AppError } from '../../../common/errors/app-error.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { ZodValidationPipe } from '../../../common/validation/zod.pipe.js';
import { ClaudeClient, ClaudeFailure } from '../../ai/claude/claude.client.js';
import { AiUsageService } from '../../ai/usage/usage.service.js';

// AI ad texts (feature 007 US8, FR-015, research R12): the 004 AI service drafts up to three main
// texts and headlines within Meta's limits, counted against the monthly assistant limit. A draft is
// only a suggestion: it fills the builder and is never submitted.

export const AiTextSchema = z
  .object({ goal: z.enum(AD_GOALS), description: z.string().trim().min(10).max(1000), language: z.string().trim().min(2).max(10).optional() })
  .strict();

const GOAL_TEXT: Record<AdGoal, string> = {
  CHATS: 'start a WhatsApp chat with the business (the button says "Send WhatsApp message")',
  LEADS: 'fill in a short lead form',
  WEBSITE: "visit the business's web page",
};

const SYSTEM = `You write short ads for Facebook, Instagram and WhatsApp Status for a small business.
Write up to three different options. Each has a main text and a headline.
Rules:
- Main text: at most ${AD_TEXT_RECOMMENDED.primaryText} characters when possible, never more than ${AD_TEXT_LIMITS.primaryText}.
- Headline: at most ${AD_TEXT_RECOMMENDED.headline} characters when possible, never more than ${AD_TEXT_LIMITS.headline}.
- Plain, friendly words. One clear reason to act. No hashtags, no ALL CAPS.
- Follow Meta's advertising standards: no false or unrealistic promises, no "guaranteed" results, no prices or offers that the description does not give, and never say or imply anything about the reader's personal attributes (health, age, money, religion, ethnicity and the like).
- Write in the language asked for; otherwise in the language of the description.
Answer with JSON only.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    options: {
      type: 'array',
      maxItems: 3,
      items: { type: 'object', properties: { primaryText: { type: 'string' }, headline: { type: 'string' } }, required: ['primaryText', 'headline'], additionalProperties: false },
    },
  },
  required: ['options'],
  additionalProperties: false,
} as const;

@Injectable()
export class AdAiTextService {
  constructor(
    private readonly claude: ClaudeClient,
    private readonly usage: AiUsageService,
    private readonly prisma: PrismaService,
  ) {}

  async draft(input: z.infer<typeof AiTextSchema>): Promise<{ options: Array<{ primaryText: string; headline: string }> }> {
    const settings = await this.usage.settings();
    if (await this.usage.assistantLimitReached(settings)) {
      throw new AppError(HttpStatus.TOO_MANY_REQUESTS, 'AI_LIMIT_REACHED', 'The monthly AI limit is reached. An admin can raise it on the AI usage page.');
    }
    const request = [`Goal: people should ${GOAL_TEXT[input.goal]}.`, `What the business offers: ${input.description}`, input.language ? `Language: ${input.language}` : null].filter(Boolean).join('\n');
    let result: Awaited<ReturnType<ClaudeClient['runTurn']>>;
    try {
      result = await this.claude.runTurn({
        system: [{ type: 'text', text: SYSTEM }],
        messages: [{ role: 'user', content: request }],
        tools: [],
        effort: 'low',
        schema: OUTPUT_SCHEMA as unknown as Record<string, unknown>,
        deadlineMs: 25_000,
        maxIterations: 1,
        maxTokens: 2_000,
      });
    } catch (error) {
      if (error instanceof ClaudeFailure) throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'AI_UNAVAILABLE', 'The AI service did not answer. Try again in a moment.');
      throw error;
    }
    const costMicros = this.usage.cost(result.usage, settings);
    await this.prisma.$transaction((tx) =>
      this.usage.record(tx, { kind: 'ASSISTANT', agentId: null, numberId: null, test: false, usage: result.usage, costMicros, at: new Date(), timezone: settings.timezone, countsAgainstMonth: true }),
    );
    let parsed: { options?: Array<{ primaryText?: unknown; headline?: unknown }> };
    try {
      parsed = JSON.parse(result.text) as typeof parsed;
    } catch {
      throw new AppError(HttpStatus.SERVICE_UNAVAILABLE, 'AI_UNAVAILABLE', 'The AI answer could not be read. Try again.');
    }
    const options = (parsed.options ?? [])
      .map((o) => ({
        primaryText: (typeof o.primaryText === 'string' ? o.primaryText : '').trim().slice(0, AD_TEXT_LIMITS.primaryText),
        headline: (typeof o.headline === 'string' ? o.headline : '').trim().slice(0, AD_TEXT_LIMITS.headline),
      }))
      .filter((o) => o.primaryText && o.headline)
      .slice(0, 3);
    return { options };
  }
}

/** POST /ads/ai-text (contracts/ads-api.openapi.yaml). */
@Controller('ads/ai-text')
export class AdAiTextController {
  constructor(private readonly texts: AdAiTextService) {}

  @Post()
  @HttpCode(200)
  @Require('campaigns.manage')
  draft(@Body(new ZodValidationPipe(AiTextSchema)) body: z.infer<typeof AiTextSchema>) {
    return this.texts.draft(body);
  }
}
