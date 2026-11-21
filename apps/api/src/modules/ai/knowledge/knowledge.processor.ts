import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleInit } from '@nestjs/common';
import { chunkBlocks, type Chunk } from '@wbm/shared';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { StorageService } from '../../../common/storage/storage.service.js';
import type { AiKnowledgeSource } from '../../../generated/prisma/client.js';
import { KNOWLEDGE_PROCESS_JOB, KNOWLEDGE_REFRESH_DUE_JOB, knowledgeProcessJob, type KnowledgeProcessJobData } from '../ai-jobs.js';
import { crawlSite } from './crawler.js';
import { extractDocx } from './extract/docx.js';
import { KnowledgeError, KNOWLEDGE_ERROR_MESSAGES } from './extract/errors.js';
import { extractPdf } from './extract/pdf.js';
import { KnowledgeQueueProcessor } from './knowledge-queue.processor.js';

const WEEK_MS = 7 * 86_400_000;
const DAY_MS = 86_400_000;

interface PreparedChunk extends Chunk {
  title: string;
  url: string | null;
}

/**
 * Reads files and websites into chunks (T038, research R11). The source's chunks are replaced in one
 * transaction; a failure marks the source FAILED with a reason the editor shows. A daily sweep
 * queues the weekly refresh of websites that asked for it (FR-012).
 */
@Injectable()
export class KnowledgeProcessor implements OnModuleInit, OnApplicationBootstrap {
  private readonly logger = new Logger(KnowledgeProcessor.name);

  constructor(
    private readonly knowledgeQueue: KnowledgeQueueProcessor,
    private readonly queues: QueueRegistry,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  onModuleInit(): void {
    this.knowledgeQueue.handle(KNOWLEDGE_PROCESS_JOB, (job) => this.process((job.data as KnowledgeProcessJobData).sourceId));
    this.knowledgeQueue.handle(KNOWLEDGE_REFRESH_DUE_JOB, () => this.queueDueRefreshes());
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.queues
      .get(QUEUES.AI_KNOWLEDGE)
      .upsertJobScheduler(KNOWLEDGE_REFRESH_DUE_JOB, { every: DAY_MS }, { name: KNOWLEDGE_REFRESH_DUE_JOB, opts: { removeOnComplete: true, removeOnFail: 20 } })
      .catch((error: unknown) => this.logger.warn({ err: (error as Error).message }, 'Could not schedule the weekly knowledge refresh'));
  }

  /** Reads one source; returns its new status. */
  async process(sourceId: string): Promise<'READY' | 'FAILED' | 'SKIPPED'> {
    const source = await this.prisma.aiKnowledgeSource.findUnique({ where: { id: sourceId } });
    if (!source || source.kind === 'ANSWER') return 'SKIPPED';
    try {
      const { chunks, pagesRead, note } = await this.read(source);
      await this.prisma.$transaction(async (tx) => {
        await tx.aiKnowledgeChunk.deleteMany({ where: { sourceId } });
        if (chunks.length) {
          await tx.aiKnowledgeChunk.createMany({
            data: chunks.map((chunk, position) => ({
              sourceId,
              agentId: source.agentId,
              position,
              title: chunk.title,
              heading: chunk.heading,
              url: chunk.url,
              page: chunk.page,
              text: chunk.text,
            })),
          });
        }
        await tx.aiKnowledgeSource.update({
          where: { id: sourceId },
          data: {
            status: 'READY',
            errorCode: null,
            errorMessage: note,
            pagesRead,
            charCount: chunks.reduce((n, c) => n + [...c.text].length, 0),
            chunkCount: chunks.length,
            lastRefreshedAt: new Date(),
          },
        });
      });
      return 'READY';
    } catch (error) {
      const known = error instanceof KnowledgeError ? error : null;
      if (!known) this.logger.error({ err: (error as Error).message, sourceId }, 'Knowledge source could not be read');
      const code = known?.code ?? (source.kind === 'WEBSITE' ? 'FETCH_FAILED' : 'UNREADABLE');
      await this.prisma.aiKnowledgeSource
        .update({ where: { id: sourceId }, data: { status: 'FAILED', errorCode: code, errorMessage: known?.message ?? KNOWLEDGE_ERROR_MESSAGES[code] } })
        .catch(() => undefined);
      return 'FAILED';
    }
  }

  private async read(source: AiKnowledgeSource): Promise<{ chunks: PreparedChunk[]; pagesRead: number | null; note: string | null }> {
    if (source.kind === 'FILE') {
      if (!source.storageKey) throw new KnowledgeError('UNREADABLE');
      const data = await this.storage.getBuffer(source.storageKey);
      const blocks = source.mimeType === 'application/pdf' ? await extractPdf(new Uint8Array(data)) : await extractDocx(data);
      const title = source.fileName ?? source.title;
      const chunks = chunkBlocks(blocks).map((chunk) => ({ ...chunk, title, url: null }));
      if (!chunks.length) throw new KnowledgeError('NO_TEXT');
      return { chunks, pagesRead: null, note: null };
    }
    const result = await crawlSite(source.url ?? '');
    const chunks = result.pages.flatMap((page) => chunkBlocks(page.blocks).map((chunk) => ({ ...chunk, title: page.title, url: page.url })));
    if (!chunks.length) throw new KnowledgeError('NO_TEXT', 'No readable text was found on the website.');
    const note = result.stoppedAtLimit ? `Reading stopped at ${result.pages.length} pages, the limit for one website.` : null;
    return { chunks, pagesRead: result.pages.length, note };
  }

  /** Queues websites whose weekly refresh is due; `now` is a parameter for tests. */
  async queueDueRefreshes(now: Date = new Date()): Promise<number> {
    const due = await this.prisma.aiKnowledgeSource.findMany({
      where: { kind: 'WEBSITE', refreshWeekly: true, enabled: true, status: { not: 'PROCESSING' }, OR: [{ lastRefreshedAt: null }, { lastRefreshedAt: { lt: new Date(now.getTime() - WEEK_MS) } }] },
      select: { id: true },
    });
    for (const { id } of due) {
      await this.prisma.aiKnowledgeSource.update({ where: { id }, data: { status: 'PROCESSING' } });
      const job = knowledgeProcessJob(id);
      await this.queues.get(QUEUES.AI_KNOWLEDGE).add(job.name, job.data, job.opts);
    }
    return due.length;
  }
}
