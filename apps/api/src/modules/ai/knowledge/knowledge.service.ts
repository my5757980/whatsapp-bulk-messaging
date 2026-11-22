import { createHash } from 'node:crypto';
import { HttpStatus, Injectable } from '@nestjs/common';
import { AI_LIMITS, answerChunk } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { z } from 'zod';
import { AppError } from '../../../common/errors/app-error.js';
import { isUniqueViolation } from '../../../common/prisma/prisma-errors.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import { StorageService } from '../../../common/storage/storage.service.js';
import type { UploadedFileData } from '../../../common/validation/uploaded-file.js';
import type { AiKnowledgeSource, Prisma } from '../../../generated/prisma/client.js';
import { AuditService, type AuditActor } from '../../audit/audit.service.js';
import { knowledgeProcessJob } from '../ai-jobs.js';
import { insertAnswer } from './answer-rows.js';
import { checkWebsiteAddress } from './crawler.js';
import { KnowledgeError } from './extract/errors.js';

export const AddAnswerSchema = z.strictObject({
  question: z.string().trim().min(1).max(AI_LIMITS.questionLength),
  answer: z.string().trim().min(1).max(AI_LIMITS.answerLength),
});
export type AddAnswerInput = z.infer<typeof AddAnswerSchema>;
export const AddWebsiteSchema = z.strictObject({ url: z.string().trim().min(1).max(2000), refreshWeekly: z.boolean().default(false) });
export type AddWebsiteInput = z.infer<typeof AddWebsiteSchema>;
export const UpdateSourceSchema = z.strictObject({
  enabled: z.boolean().optional(),
  question: z.string().trim().min(1).max(AI_LIMITS.questionLength).optional(),
  answer: z.string().trim().min(1).max(AI_LIMITS.answerLength).optional(),
  refreshWeekly: z.boolean().optional(),
});
export type UpdateSourceInput = z.infer<typeof UpdateSourceSchema>;

const PDF = 'application/pdf';
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** The KnowledgeSource DTO of contracts/ai-api.openapi.yaml. */
export function toSourceDto(row: AiKnowledgeSource) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    enabled: row.enabled,
    status: row.status,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
    question: row.question,
    answer: row.answer,
    url: row.url,
    refreshWeekly: row.refreshWeekly,
    pagesRead: row.pagesRead,
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    charCount: row.charCount,
    lastRefreshedAt: row.lastRefreshedAt?.toISOString() ?? null,
    replaceMe: row.replaceMe,
  };
}

/** PDF or DOCX by declared type or by extension; null for anything else. */
function fileKind(file: UploadedFileData): typeof PDF | typeof DOCX | null {
  const name = file.originalname.toLowerCase();
  if (file.mimetype === PDF || name.endsWith('.pdf')) return PDF;
  if (file.mimetype === DOCX || name.endsWith('.docx')) return DOCX;
  return null;
}

/**
 * Agent knowledge (T037, FR-011–FR-013): written answers (ready at once, one chunk each), websites and
 * files (read in the background on the ai-knowledge queue), switches, edits, refreshes and deletes.
 */
@Injectable()
export class KnowledgeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly storage: StorageService,
    private readonly queues: QueueRegistry,
  ) {}

  async list(agentId: string) {
    await this.agentOrThrow(agentId);
    const sources = await this.prisma.aiKnowledgeSource.findMany({ where: { agentId }, orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }] });
    const totalChars = sources.filter((s) => s.enabled && s.status === 'READY').reduce((n, s) => n + s.charCount, 0);
    return {
      sources: sources.map(toSourceDto),
      totalChars,
      mode: totalChars <= AI_LIMITS.wholeKnowledgeChars ? 'WHOLE' : 'SEARCH',
      limits: { answers: AI_LIMITS.answers, websites: AI_LIMITS.websites, files: AI_LIMITS.files },
    };
  }

  async addAnswer(agentId: string, input: AddAnswerInput, actor: AuditActor) {
    await this.agentOrThrow(agentId);
    await this.checkLimit(agentId, 'ANSWER', AI_LIMITS.answers);
    const row = await this.prisma.$transaction((tx) => insertAnswer(tx, agentId, input, { replaceMe: false, createdById: actor.userId ?? null }));
    await this.audit.record(actor, 'ai.knowledge_added', { type: 'ai_agent', id: agentId }, { kind: 'ANSWER', sourceId: row.id });
    return toSourceDto(row);
  }

  async addWebsite(agentId: string, input: AddWebsiteInput, actor: AuditActor) {
    await this.agentOrThrow(agentId);
    let url: URL;
    try {
      url = checkWebsiteAddress(input.url);
    } catch (error) {
      const code = error instanceof KnowledgeError ? error.code : 'FETCH_FAILED';
      throw new AppError(HttpStatus.UNPROCESSABLE_ENTITY, code, error instanceof Error ? error.message : 'The address cannot be read');
    }
    await this.checkLimit(agentId, 'WEBSITE', AI_LIMITS.websites);
    const row = await this.prisma.aiKnowledgeSource.create({
      data: {
        agentId,
        kind: 'WEBSITE',
        title: `${url.host}${url.pathname}`.slice(0, 200),
        url: url.href,
        refreshWeekly: input.refreshWeekly,
        status: 'PROCESSING',
        createdById: actor.userId ?? null,
      },
    });
    await this.queueProcessing(row.id);
    await this.audit.record(actor, 'ai.knowledge_added', { type: 'ai_agent', id: agentId }, { kind: 'WEBSITE', sourceId: row.id, host: url.host });
    return toSourceDto(row);
  }

  async addFile(agentId: string, file: UploadedFileData | undefined, actor: AuditActor) {
    await this.agentOrThrow(agentId);
    if (!file) throw AppError.validation('Choose a file to upload', [{ field: 'file', issue: 'is required' }]);
    if (file.size > AI_LIMITS.fileBytes) throw new AppError(HttpStatus.PAYLOAD_TOO_LARGE, 'TOO_LARGE', 'Files can be at most 20 MB');
    const mimeType = fileKind(file);
    if (!mimeType) throw new AppError(HttpStatus.UNSUPPORTED_MEDIA_TYPE, 'UNSUPPORTED_TYPE', 'Only PDF and Word (DOCX) files can be added');
    await this.checkLimit(agentId, 'FILE', AI_LIMITS.files);
    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    if (await this.prisma.aiKnowledgeSource.findFirst({ where: { agentId, sha256 }, select: { id: true } })) {
      throw AppError.conflict('This file has already been added to the agent', 'DUPLICATE_FILE');
    }
    const storageKey = `ai-knowledge/${uuidv7()}${mimeType === PDF ? '.pdf' : '.docx'}`;
    await this.storage.put(storageKey, file.buffer, mimeType);
    let row: AiKnowledgeSource;
    try {
      row = await this.prisma.aiKnowledgeSource.create({
        data: {
          agentId,
          kind: 'FILE',
          title: file.originalname.slice(0, 200) || 'File',
          fileName: file.originalname.slice(0, 240),
          mimeType,
          sizeBytes: file.size,
          sha256,
          storageKey,
          status: 'PROCESSING',
          createdById: actor.userId ?? null,
        },
      });
    } catch (error) {
      await this.storage.delete(storageKey).catch(() => undefined);
      if (isUniqueViolation(error)) throw AppError.conflict('This file has already been added to the agent', 'DUPLICATE_FILE');
      throw error;
    }
    await this.queueProcessing(row.id);
    await this.audit.record(actor, 'ai.knowledge_added', { type: 'ai_agent', id: agentId }, { kind: 'FILE', sourceId: row.id, sizeBytes: file.size });
    return toSourceDto(row);
  }

  async update(agentId: string, sourceId: string, input: UpdateSourceInput, actor: AuditActor) {
    const source = await this.sourceOrThrow(agentId, sourceId);
    if ((input.question !== undefined || input.answer !== undefined) && source.kind !== 'ANSWER') {
      throw AppError.validation('Only written answers can be edited', [{ field: 'answer', issue: 'is only for written answers' }]);
    }
    if (input.refreshWeekly !== undefined && source.kind !== 'WEBSITE') {
      throw AppError.validation('Only websites can be refreshed weekly', [{ field: 'refreshWeekly', issue: 'is only for websites' }]);
    }
    const question = input.question ?? source.question ?? '';
    const answer = input.answer ?? source.answer ?? '';
    const edited = source.kind === 'ANSWER' && (input.question !== undefined || input.answer !== undefined);
    const row = await this.prisma.$transaction(async (tx) => {
      const data: Prisma.AiKnowledgeSourceUpdateInput = {
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        ...(input.refreshWeekly !== undefined ? { refreshWeekly: input.refreshWeekly } : {}),
      };
      if (edited) {
        const chunk = answerChunk(question, answer);
        Object.assign(data, { question, answer, title: question, replaceMe: false, charCount: [...chunk.text].length, lastRefreshedAt: new Date() });
        await tx.aiKnowledgeChunk.deleteMany({ where: { sourceId } });
        await tx.aiKnowledgeChunk.create({ data: { sourceId, agentId, position: 0, title: question, text: chunk.text } });
      }
      return tx.aiKnowledgeSource.update({ where: { id: sourceId }, data });
    });
    if (input.enabled !== undefined && input.enabled !== source.enabled) {
      await this.audit.record(actor, 'ai.knowledge_switched', { type: 'ai_agent', id: agentId }, { sourceId, enabled: input.enabled });
    }
    return toSourceDto(row);
  }

  async remove(agentId: string, sourceId: string, actor: AuditActor): Promise<void> {
    const source = await this.sourceOrThrow(agentId, sourceId);
    await this.prisma.aiKnowledgeSource.delete({ where: { id: sourceId } });
    if (source.storageKey) await this.storage.delete(source.storageKey).catch(() => undefined);
    await this.audit.record(actor, 'ai.knowledge_deleted', { type: 'ai_agent', id: agentId }, { kind: source.kind, sourceId });
  }

  async refresh(agentId: string, sourceId: string, actor: AuditActor) {
    const source = await this.sourceOrThrow(agentId, sourceId);
    if (source.kind === 'ANSWER') throw AppError.conflict('Written answers do not need refreshing', 'NOT_REFRESHABLE');
    if (source.status === 'PROCESSING') throw AppError.conflict('This source is being read already', 'ALREADY_PROCESSING');
    const row = await this.prisma.aiKnowledgeSource.update({ where: { id: sourceId }, data: { status: 'PROCESSING', errorCode: null, errorMessage: null } });
    await this.queueProcessing(sourceId);
    await this.audit.record(actor, 'ai.knowledge_refreshed', { type: 'ai_agent', id: agentId }, { kind: source.kind, sourceId });
    return toSourceDto(row);
  }

  async queueProcessing(sourceId: string): Promise<void> {
    const job = knowledgeProcessJob(sourceId);
    await this.queues.get(QUEUES.AI_KNOWLEDGE).add(job.name, job.data, job.opts);
  }

  private async checkLimit(agentId: string, kind: 'ANSWER' | 'WEBSITE' | 'FILE', limit: number): Promise<void> {
    const count = await this.prisma.aiKnowledgeSource.count({ where: { agentId, kind } });
    if (count >= limit) {
      const what = kind === 'ANSWER' ? 'written answers' : kind === 'WEBSITE' ? 'websites' : 'files';
      throw AppError.validation(`An agent can have at most ${limit} ${what}`, [{ field: 'kind', issue: `limit of ${limit} reached` }], 'LIMIT_EXCEEDED');
    }
  }

  private async agentOrThrow(agentId: string): Promise<void> {
    const agent = await this.prisma.aiAgent.findFirst({ where: { id: agentId, deletedAt: null }, select: { id: true } });
    if (!agent) throw AppError.notFound('Agent not found');
  }

  private async sourceOrThrow(agentId: string, sourceId: string): Promise<AiKnowledgeSource> {
    await this.agentOrThrow(agentId);
    const source = await this.prisma.aiKnowledgeSource.findFirst({ where: { id: sourceId, agentId } });
    if (!source) throw AppError.notFound('Knowledge source not found');
    return source;
  }
}
