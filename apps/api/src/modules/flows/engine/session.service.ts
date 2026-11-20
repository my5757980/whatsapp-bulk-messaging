import { Injectable, Logger } from '@nestjs/common';
import { checkChatMedia, FlowGraphSchema, type FlowGraph } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { isLive } from '../../inbox/conversations/window.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import { requestSendWorkerSync, sessionSendJob } from '../../sending/send-jobs.js';
import type { FlowOutboundMessage, FlowSessionResult } from './effects.js';
import { renderFlowText } from './render.js';
import { newSessionState, run, type FlowInput, type RunResult, type SessionState } from './run.js';

type Tx = Prisma.TransactionClient;

/** Messages from one engine run are queued this far apart so they arrive in order (research R6). */
export const FLOW_SEND_SPACING_MS = 1_000;

export interface StartRequest {
  flowId: string;
  /** null runs the flow's draft (test numbers, FR-034). */
  versionId: string | null;
  conversationId: string;
  startedBy: 'TRIGGER' | 'MEMBER' | 'JUMP';
  startedByUserId?: string | null;
  triggerKey?: string | null;
  isTest?: boolean;
  parentSessionId?: string | null;
  answers?: Record<string, unknown>;
  /** End a running session first with this result instead of refusing (interrupting triggers, member starts). */
  replaceRunning?: FlowSessionResult;
}

export type StartOutcome = { started: true; sessionId: string } | { started: false; reason: 'busy' | 'flow_missing' };

interface FlowMeta {
  id: string;
  name: string;
  status: 'DRAFT' | 'PUBLISHED' | 'UNPUBLISHED';
  graph: FlowGraph;
  versionId: string | null;
}

/** Work that must wait until the transaction has committed. */
interface AfterCommit {
  numberId: string;
  conversationId: string;
  sendItemIds: string[];
  timers: Array<{ sessionId: string; token: number; purpose: 'delay' | 'timeout'; delayMs: number }>;
  apiCalls: Array<{ sessionId: string; token: number }>;
  touched: boolean;
}

type SessionRow = Prisma.FlowSessionGetPayload<object>;

/**
 * Runs chatbot flow sessions (003 research R4, T010). Every start, customer message, timer and API
 * result is applied in one transaction under an advisory lock on the conversation, so a chat never
 * has two running sessions and never gets a step twice (FR-024, SC-004).
 */
@Injectable()
export class FlowSessionService {
  private readonly logger = new Logger(FlowSessionService.name);
  /** Published versions never change, so their parsed graphs can be kept. */
  private readonly versionGraphs = new Map<string, FlowGraph>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly queues: QueueRegistry,
    private readonly publisher: InboxPublisher,
  ) {}

  /** Starts a flow for a chat; refuses when a session is already running unless asked to replace it. */
  async start(request: StartRequest): Promise<StartOutcome> {
    const flow = await this.loadFlow(request.flowId, request.versionId);
    if (!flow) return { started: false, reason: 'flow_missing' };
    const outcome = await this.inConversation(request.conversationId, async (tx, after) => {
      const running = await tx.flowSession.findFirst({ where: { conversationId: request.conversationId, status: 'RUNNING' } });
      if (running) {
        if (!request.replaceRunning) return { started: false as const, reason: 'busy' as const };
        await this.finish(tx, running, request.replaceRunning);
      }
      const conversation = await tx.conversation.findUniqueOrThrow({ where: { id: request.conversationId }, select: { numberId: true, contactId: true } });
      const id = uuidv7();
      const answers = request.answers ?? {};
      const row = await tx.flowSession.create({
        data: {
          id,
          flowId: flow.id,
          flowVersionId: flow.versionId,
          conversationId: request.conversationId,
          contactId: conversation.contactId,
          numberId: conversation.numberId,
          isTest: request.isTest ?? false,
          startedBy: request.startedBy,
          startedByUserId: request.startedByUserId ?? null,
          triggerKey: request.triggerKey ?? null,
          parentSessionId: request.parentSessionId ?? null,
          answers: answers as Prisma.InputJsonValue,
        },
      });
      if (conversation.contactId) {
        await tx.conversationEvent.create({
          data: { conversationId: request.conversationId, type: 'FLOW_STARTED', actorType: 'FLOW', data: { flowId: flow.id, flowName: flow.name, test: request.isTest ?? false } },
        });
      }
      const state: SessionState = { ...newSessionState(id), answers };
      await this.step(tx, row, flow, state, { kind: 'start' }, after);
      return { started: true as const, sessionId: id };
    });
    return outcome;
  }

  /**
   * Gives a customer message to the chat's running session; false when no session takes it.
   * `memberStartedOnly` is set while the chat is Waiting for agent or Taken (FR-025).
   */
  async continueWith(conversationId: string, input: Extract<FlowInput, { kind: 'message' }>, options: { memberStartedOnly?: boolean } = {}): Promise<boolean> {
    return this.inConversation(conversationId, async (tx, after) => {
      const row = await tx.flowSession.findFirst({ where: { conversationId, status: 'RUNNING' } });
      if (!row) return false;
      if (options.memberStartedOnly && row.startedBy !== 'MEMBER') return false;
      const flow = await this.loadFlow(row.flowId, row.flowVersionId);
      // An unpublished (or deleted) flow ends its sessions at their next step (FR-004); tests run the draft.
      if (!flow || (!row.isTest && flow.status !== 'PUBLISHED')) {
        await this.finish(tx, row, 'FLOW_UNPUBLISHED');
        return true;
      }
      await this.step(tx, row, flow, this.stateOf(row), input, after);
      return true;
    });
  }

  /** A timer or an API result for a session; stale tokens do nothing (research R10). */
  async resume(sessionId: string, input: Extract<FlowInput, { kind: 'timer' | 'api' }>): Promise<void> {
    const session = await this.prisma.flowSession.findUnique({ where: { id: sessionId }, select: { conversationId: true } });
    if (!session) return;
    await this.inConversation(session.conversationId, async (tx, after) => {
      const row = await tx.flowSession.findUnique({ where: { id: sessionId } });
      if (!row || row.status !== 'RUNNING' || row.waitToken !== input.token) return;
      const flow = await this.loadFlow(row.flowId, row.flowVersionId);
      if (!flow || (!row.isTest && flow.status !== 'PUBLISHED')) return this.finish(tx, row, 'FLOW_UNPUBLISHED');
      await this.step(tx, row, flow, this.stateOf(row), input, after);
    });
  }

  /** The chat's running session, if any (id, flow and how it started). */
  async runningSession(conversationId: string): Promise<{ id: string; flowId: string; startedBy: 'TRIGGER' | 'MEMBER' | 'JUMP' } | null> {
    return this.prisma.flowSession.findFirst({ where: { conversationId, status: 'RUNNING' }, select: { id: true, flowId: true, startedBy: true } });
  }

  /** Ends the chat's running session (member took over, opt-out, block…); true when one ended. */
  async endRunning(conversationId: string, result: FlowSessionResult, reason?: string): Promise<boolean> {
    return this.inConversation(conversationId, async (tx) => {
      const row = await tx.flowSession.findFirst({ where: { conversationId, status: 'RUNNING' } });
      if (!row) return false;
      await this.finish(tx, row, result, reason);
      return true;
    });
  }

  /** The session currently answering a chat, for the live chat banner. */
  async running(conversationId: string) {
    const row = await this.prisma.flowSession.findFirst({
      where: { conversationId, status: 'RUNNING' },
      include: { flow: { select: { name: true } } },
    });
    if (!row) return null;
    return {
      sessionId: row.id,
      flowId: row.flowId,
      flowName: row.flow.name,
      stepId: row.currentStepId,
      startedAt: row.startedAt.toISOString(),
      startedBy: row.startedBy,
      test: row.isTest,
    };
  }

  // ---------- internals ----------

  private async inConversation<T>(conversationId: string, work: (tx: Tx, after: AfterCommit) => Promise<T>): Promise<T> {
    const after: AfterCommit = { numberId: '', conversationId, sendItemIds: [], timers: [], apiCalls: [], touched: false };
    const result = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`flow-conversation:${conversationId}`}::text))`;
        return work(tx, after);
      },
      { timeout: 15_000 },
    );
    await this.flush(after);
    return result;
  }

  private stateOf(row: SessionRow): SessionState {
    return {
      sessionId: row.id,
      currentStepId: row.currentStepId,
      wait: row.wait,
      waitToken: row.waitToken,
      retries: row.retries,
      stepsSinceInput: row.stepsSinceInput,
      answers: (row.answers ?? {}) as Record<string, unknown>,
      ended: row.status === 'ENDED',
    };
  }

  private async loadFlow(flowId: string, versionId: string | null): Promise<FlowMeta | null> {
    const flow = await this.prisma.flow.findUnique({ where: { id: flowId }, select: { id: true, name: true, status: true, draft: true, deletedAt: true } });
    if (!flow || flow.deletedAt) return null;
    if (versionId === null) return { id: flow.id, name: flow.name, status: flow.status, versionId: null, graph: FlowGraphSchema.parse(flow.draft) };
    let graph = this.versionGraphs.get(versionId);
    if (!graph) {
      const version = await this.prisma.flowVersion.findUnique({ where: { id: versionId }, select: { graph: true } });
      if (!version) return null;
      graph = FlowGraphSchema.parse(version.graph);
      if (this.versionGraphs.size > 500) this.versionGraphs.clear();
      this.versionGraphs.set(versionId, graph);
    }
    return { id: flow.id, name: flow.name, status: flow.status, versionId, graph };
  }

  /** Runs the engine for one input and applies its effects inside the transaction. */
  private async step(tx: Tx, row: SessionRow, flow: FlowMeta, state: SessionState, input: FlowInput, after: AfterCommit): Promise<void> {
    const conversation = await tx.conversation.findUniqueOrThrow({
      where: { id: row.conversationId },
      select: { id: true, numberId: true, lastCustomerMessageAt: true, contact: { select: { name: true, phoneE164: true, attributes: true } } },
    });
    after.numberId = conversation.numberId;
    const contact = {
      name: conversation.contact?.name ?? null,
      phoneE164: conversation.contact?.phoneE164 ?? null,
      attributes: (conversation.contact?.attributes ?? {}) as Record<string, unknown>,
    };
    const result: RunResult = run(state, input, {
      graph: flow.graph,
      render: (text, fallbacks, answers) => renderFlowText(text, contact, fallbacks, answers),
    });
    await this.apply(tx, row, flow, result, conversation.lastCustomerMessageAt, after);
  }

  private async apply(tx: Tx, row: SessionRow, flow: FlowMeta, result: RunResult, lastCustomerMessageAt: Date | null, after: AfterCommit): Promise<void> {
    const now = new Date();
    let state = result.state;
    let ended: { result: FlowSessionResult; reason?: string } | null = null;
    const openRows = new Map<string, bigint>();

    for (const effect of result.effects) {
      if (ended) break;
      switch (effect.kind) {
        case 'stepEntered': {
          if (row.isTest) break;
          const created = await tx.flowSessionStep.create({ data: { sessionId: row.id, flowId: row.flowId, flowVersionId: row.flowVersionId, stepId: effect.stepId, enteredAt: now }, select: { id: true } });
          openRows.set(effect.stepId, created.id);
          break;
        }
        case 'stepLeft': {
          if (row.isTest) break;
          const id = openRows.get(effect.stepId);
          if (id !== undefined) {
            await tx.flowSessionStep.update({ where: { id }, data: { leftAt: now, branch: effect.branch } });
          } else {
            // Entered in an earlier run (a waiting step).
            const open = await tx.flowSessionStep.findFirst({ where: { sessionId: row.id, stepId: effect.stepId, leftAt: null }, orderBy: { id: 'desc' }, select: { id: true } });
            if (open) await tx.flowSessionStep.update({ where: { id: open.id }, data: { leftAt: now, branch: effect.branch } });
          }
          openRows.delete(effect.stepId);
          break;
        }
        case 'send': {
          // Free-form messages only inside the 24-hour window (FR-028).
          if (!isLive(lastCustomerMessageAt, now)) {
            ended = { result: 'WINDOW_CLOSED' };
            break;
          }
          const itemId = await this.createItem(tx, row, flow, effect.stepId, effect.message, now);
          if (itemId) after.sendItemIds.push(itemId);
          break;
        }
        case 'schedule':
          after.timers.push({ sessionId: row.id, token: state.waitToken, purpose: effect.purpose, delayMs: effect.delayMs });
          break;
        case 'callApi':
          after.apiCalls.push({ sessionId: row.id, token: state.waitToken });
          break;
        case 'end':
          ended = effect.reason ? { result: effect.result, reason: effect.reason } : { result: effect.result };
          break;
        case 'setAttributes':
        case 'tags':
        case 'handover':
        case 'jump':
          // Applied from their stories (US2–US4); the engine does not emit them before then.
          this.logger.warn({ sessionId: row.id, effect: effect.kind }, 'Flow effect not handled yet');
          break;
      }
    }

    if (ended) {
      state = { ...state, currentStepId: null, wait: 'NONE', ended: true };
      await tx.flowSession.update({
        where: { id: row.id },
        data: { ...this.stateData(state, now), status: 'ENDED', result: ended.result, failureReason: ended.reason?.slice(0, 120) ?? null, endedAt: now },
      });
      await this.endJourney(tx, row, flow.name, ended.result);
    } else {
      await tx.flowSession.update({ where: { id: row.id }, data: this.stateData(state, now) });
    }
    if (after.sendItemIds.length) after.touched = true;
  }

  private stateData(state: SessionState, now: Date) {
    return {
      currentStepId: state.currentStepId,
      wait: state.wait,
      waitToken: state.waitToken,
      retries: state.retries,
      stepsSinceInput: state.stepsSinceInput,
      answers: state.answers as Prisma.InputJsonValue,
      lastActivityAt: now,
    };
  }

  /** Ends a session outside an engine run (member, opt-out, block, unpublish, expiry). */
  private async finish(tx: Tx, row: SessionRow, result: FlowSessionResult, reason?: string): Promise<void> {
    const now = new Date();
    await tx.flowSession.update({
      where: { id: row.id },
      data: { status: 'ENDED', result, failureReason: reason?.slice(0, 120) ?? null, endedAt: now, wait: 'NONE', lastActivityAt: now },
    });
    const flow = await tx.flow.findUnique({ where: { id: row.flowId }, select: { name: true } });
    await this.endJourney(tx, row, flow?.name ?? '', result);
  }

  private async endJourney(tx: Tx, row: SessionRow, flowName: string, result: FlowSessionResult): Promise<void> {
    if (!row.contactId) return;
    await tx.conversationEvent.create({
      data: { conversationId: row.conversationId, type: 'FLOW_ENDED', actorType: 'FLOW', data: { flowId: row.flowId, flowName, result, test: row.isTest } },
    });
  }

  /** A flow message as a 002 chat item (origin AUTOMATIC, FR-030); returns its id. */
  private async createItem(tx: Tx, row: SessionRow, flow: FlowMeta, stepId: string, message: FlowOutboundMessage, now: Date): Promise<string | null> {
    const id = uuidv7();
    const flowInfo = { flowId: flow.id, flowName: flow.name, sessionId: row.id, stepId, test: row.isTest };
    let contentType: 'TEXT' | 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT' | 'BUTTONS' | 'LIST' = 'TEXT';
    let text: string | null = null;
    let mediaAssetId: string | null = null;
    let payload: Record<string, unknown> = { flow: flowInfo };
    switch (message.type) {
      case 'text':
        text = message.text;
        break;
      case 'media': {
        const asset = await tx.mediaAsset.findUnique({ where: { id: message.mediaAssetId }, select: { id: true, mimeType: true, sizeBytes: true, displayName: true } });
        const check = asset ? checkChatMedia(asset.mimeType, asset.sizeBytes) : null;
        if (!asset || !check?.ok) {
          this.logger.warn({ sessionId: row.id, stepId, mediaAssetId: message.mediaAssetId }, 'Flow media file is not available; sending the text only');
          if (!message.caption) return null;
          text = message.caption;
          break;
        }
        contentType = check.kind === 'image' ? 'IMAGE' : check.kind === 'video' ? 'VIDEO' : check.kind === 'audio' ? 'AUDIO' : 'DOCUMENT';
        mediaAssetId = asset.id;
        text = contentType === 'AUDIO' ? null : (message.caption ?? null);
        payload = { ...payload, mimeType: asset.mimeType, sizeBytes: asset.sizeBytes, ...(contentType === 'DOCUMENT' ? { fileName: asset.displayName ?? 'document' } : {}) };
        break;
      }
      case 'buttons':
        contentType = 'BUTTONS';
        text = message.text;
        payload = { ...payload, header: message.header ?? null, footer: message.footer ?? null, buttons: message.buttons };
        break;
      case 'list':
        contentType = 'LIST';
        text = message.text;
        payload = { ...payload, header: message.header ?? null, footer: message.footer ?? null, buttonLabel: message.buttonLabel, sections: message.sections };
        break;
    }
    await tx.chatMessage.create({
      data: { id, conversationId: row.conversationId, kind: 'SESSION_OUT', origin: 'AUTOMATIC', contentType, text, mediaAssetId, payload: payload as Prisma.InputJsonValue, status: 'QUEUED', occurredAt: now },
    });
    const preview = (text ?? (contentType === 'AUDIO' ? 'Audio' : contentType)).replace(/\s+/g, ' ').trim().slice(0, 120);
    await tx.$executeRaw`
      UPDATE conversations
         SET last_activity_at = GREATEST(last_activity_at, ${now}), last_message_preview = ${preview}, updated_at = now()
       WHERE id = ${row.conversationId}::uuid`;
    return id;
  }

  /** Queues sends and timers and publishes live events once the transaction has committed. */
  private async flush(after: AfterCommit): Promise<void> {
    try {
      if (after.sendItemIds.length) {
        const queue = this.queues.sendQueue(after.numberId);
        for (const [index, itemId] of after.sendItemIds.entries()) {
          const job = sessionSendJob(itemId);
          await queue.add(job.name, job.data, { ...job.opts, ...(index > 0 ? { delay: index * FLOW_SEND_SPACING_MS } : {}) });
        }
        await requestSendWorkerSync(this.queues);
        for (const itemId of after.sendItemIds) await this.publisher.itemCreated(itemId);
      }
      if (after.touched) await this.publisher.conversation(after.conversationId);
      for (const timer of after.timers) await this.queueTimer(timer);
      for (const call of after.apiCalls) await this.queueApiCall(call);
    } catch (error) {
      this.logger.error({ err: (error as Error).message, conversationId: after.conversationId }, 'Could not queue flow work after commit');
    }
  }

  /** Delayed `flow-timer` job (research R10); implemented with US2. */
  protected async queueTimer(timer: AfterCommit['timers'][number]): Promise<void> {
    this.logger.warn({ sessionId: timer.sessionId }, 'Flow timers arrive with US2');
  }

  /** `flow-api` job (research R11); implemented with US5. */
  protected async queueApiCall(call: AfterCommit['apiCalls'][number]): Promise<void> {
    this.logger.warn({ sessionId: call.sessionId }, 'Flow API steps arrive with US5');
  }
}
