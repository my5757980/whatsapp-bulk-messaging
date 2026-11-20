import { Injectable } from '@nestjs/common';
import { pickKeywordTrigger } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';

export interface TriggerMatch {
  flowId: string;
  versionId: string;
  triggerKey: string;
  canInterrupt: boolean;
}

/**
 * Finds the published flow a customer message starts (003 T024, research R2). Reads the trigger
 * rows on every message, without a worker cache, so newly published flows apply at once.
 * Patterns, template buttons and first-message rules arrive with US6.
 */
@Injectable()
export class TriggerMatcher {
  constructor(private readonly prisma: PrismaService) {}

  async keyword(numberId: string, text: string | null, options: { interruptingOnly?: boolean } = {}): Promise<TriggerMatch | null> {
    if (!text?.trim()) return null;
    const rows = await this.prisma.flowTrigger.findMany({
      where: {
        kind: 'KEYWORD',
        ...(options.interruptingOnly ? { canInterrupt: true } : {}),
        flow: { status: 'PUBLISHED', deletedAt: null, OR: [{ allNumbers: true }, { numbers: { some: { numberId } } }] },
      },
      select: { flowId: true, triggerKey: true, match: true, phrase: true, canInterrupt: true, flowVersionId: true, flow: { select: { priority: true, createdAt: true, publishedVersionId: true } } },
    });
    const candidates = rows
      .filter((r) => r.phrase && r.match && r.flowVersionId === r.flow.publishedVersionId)
      .map((r) => ({
        flowId: r.flowId,
        versionId: r.flowVersionId,
        triggerKey: r.triggerKey,
        match: r.match!,
        phrase: r.phrase!,
        priority: r.flow.priority,
        flowCreatedAt: r.flow.createdAt,
        canInterrupt: r.canInterrupt,
      }));
    const winner = pickKeywordTrigger(text, candidates);
    return winner ? { flowId: winner.flowId, versionId: winner.versionId, triggerKey: winner.triggerKey, canInterrupt: winner.canInterrupt } : null;
  }
}
