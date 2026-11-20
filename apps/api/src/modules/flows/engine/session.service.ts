import { Injectable, Logger } from '@nestjs/common';
import { checkChatMedia, FlowGraphSchema, type AnswerContext, type FlowGraph, type StepOf } from '@wbm/shared';
import { v7 as uuidv7 } from 'uuid';
import { MetricsService } from '../../../common/metrics/metrics.service.js';
import { normalizePhone } from '../../../common/phone/phone.js';
import { PrismaService } from '../../../common/prisma/prisma.service.js';
import { QUEUES } from '../../../common/queue/queue.constants.js';
import { QueueRegistry } from '../../../common/queue/queue.module.js';
import type { Prisma } from '../../../generated/prisma/client.js';
import { validateAttributeValue, type AttributeValue } from '../../contacts/attribute-validator.js';
import { isLive } from '../../inbox/conversations/window.js';
import { InboxPublisher } from '../../inbox/realtime/inbox-publisher.js';
import { ChatRoutingService } from '../../inbox/routing/chat-routing.service.js';
import { LiveChatSettingsService } from '../../inbox/settings/live-chat-settings.service.js';
import { requestSendWorkerSync, sessionSendJob } from '../../sending/send-jobs.js';
import { SettingsService } from '../../settings/settings.service.js';
import { FLOW_API_JOB, FLOW_TIMER_JOB, flowApiJobId, flowTimerJobId, todayIn, type FlowApiData, type FlowTimerData } from '../steps/flow-jobs.js';
import type { FlowOutboundMessage, FlowSessionResult } from './effects.js';
import { renderFlowText } from './render.js';
import { newSessionState, run, type FlowFacts, type FlowInput, type RunResult, type SessionState } from './run.js';

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
  /** A contact whose attributes a flow changed (live chat refreshes its profile). */
  contactChanged: string | null;
  /** The chat moved to Waiting for agent (hand-over): alert members after commit. */
  requested: boolean;
  /** Notes added by hand-over steps, shown live after commit. */
  noteIds: string[];
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
    private readonly settings: SettingsService,
    private readonly liveChat: LiveChatSettingsService,
    private readonly routing: ChatRoutingService,
    private readonly metrics: MetricsService,
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
      const id = await this.createAndRun(tx, flow, request, after);
      return { started: true as const, sessionId: id };
    });
    return outcome;
  }

  /**
   * Creates a session and runs the flow from its start step, inside the caller's transaction. A jump
   * passes the parent's answers and step count, so loops of jumps still stop after 50 steps (FR-033).
   */
  private async createAndRun(tx: Tx, flow: FlowMeta, request: StartRequest & { stepsSinceInput?: number }, after: AfterCommit): Promise<string> {
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
    const state: SessionState = { ...newSessionState(id), answers, stepsSinceInput: request.stepsSinceInput ?? 0 };
    await this.step(tx, row, flow, state, { kind: 'start' }, after);
    return id;
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
  async runningSession(conversationId: string): Promise<{ id: string; flowId: string; startedBy: 'TRIGGER' | 'MEMBER' | 'JUMP' | 'AI_AGENT' } | null> {
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

  /**
   * Ends a session idle since before `cutoff` as EXPIRED (FR-032); false when it moved on or ended
   * meanwhile. Called by the expiry sweep.
   */
  async expire(sessionId: string, cutoff: Date): Promise<boolean> {
    const session = await this.prisma.flowSession.findUnique({ where: { id: sessionId }, select: { conversationId: true } });
    if (!session) return false;
    return this.inConversation(session.conversationId, async (tx) => {
      const row = await tx.flowSession.findUnique({ where: { id: sessionId } });
      if (!row || row.status !== 'RUNNING' || row.lastActivityAt >= cutoff) return false;
      await this.finish(tx, row, 'EXPIRED');
      return true;
    });
  }

  /** What a flow-api job needs: the step, the answers and the contact; null once the wait is over. */
  async apiCall(sessionId: string, token: number): Promise<{ flowId: string; step: StepOf<'api'>; answers: Record<string, unknown>; contact: { name: string | null; phoneE164: string | null; attributes: Record<string, unknown> } } | null> {
    const row = await this.prisma.flowSession.findUnique({ where: { id: sessionId }, include: { contact: { select: { name: true, phoneE164: true, attributes: true } } } });
    if (!row || row.status !== 'RUNNING' || row.wait !== 'API' || row.waitToken !== token) return null;
    const flow = await this.loadFlow(row.flowId, row.flowVersionId);
    const step = flow?.graph.steps.find((s) => s.id === row.currentStepId);
    if (!flow || step?.type !== 'api') return null;
    return {
      flowId: row.flowId,
      step,
      answers: (row.answers ?? {}) as Record<string, unknown>,
      contact: { name: row.contact?.name ?? null, phoneE164: row.contact?.phoneE164 ?? null, attributes: (row.contact?.attributes ?? {}) as Record<string, unknown> },
    };
  }

  /**
   * A first-message rule sets the contact's first-message tag (002 FR-033, 003 FR-019), with a journey
   * entry by the flow on each of the contact's chats; a deleted tag or an unchanged one does nothing.
   */
  async setFirstMessageTag(contactId: string, tagId: string, flowId: string): Promise<void> {
    const [contact, tag, flow] = await Promise.all([
      this.prisma.contact.findUnique({ where: { id: contactId }, select: { firstMessageTagId: true, firstMessageTag: { select: { name: true } } } }),
      this.prisma.tag.findUnique({ where: { id: tagId }, select: { id: true, name: true } }),
      this.prisma.flow.findUnique({ where: { id: flowId }, select: { name: true } }),
    ]);
    if (!contact || !tag || contact.firstMessageTagId === tag.id) return;
    await this.prisma.contact.update({ where: { id: contactId }, data: { firstMessageTagId: tag.id } });
    const chats = await this.prisma.conversation.findMany({ where: { contactId }, select: { id: true } });
    await this.prisma.conversationEvent.createMany({
      data: chats.map((chat) => ({
        conversationId: chat.id,
        type: 'FIRST_MESSAGE_TAG_CHANGED' as const,
        actorType: 'FLOW' as const,
        data: { from: contact.firstMessageTag?.name ?? null, to: tag.name, flowId, flowName: flow?.name ?? '' },
      })),
    });
    await this.publisher.contactUpdated(contactId);
  }

  /** A member took, answered or sent a template in the chat: the flow stops (FR-026). */
  async stopForConversation(conversationId: string): Promise<boolean> {
    return this.endRunning(conversationId, 'STOPPED_BY_MEMBER');
  }

  /** A session as the live chat banner shows it (ended sessions too, e.g. a flow that finished at once). */
  async describe(sessionId: string) {
    const row = await this.prisma.flowSession.findUnique({ where: { id: sessionId }, include: { flow: { select: { name: true } } } });
    return row ? this.toRunning(row) : null;
  }

  /** The session currently answering a chat, for the live chat banner. */
  async running(conversationId: string) {
    const row = await this.prisma.flowSession.findFirst({
      where: { conversationId, status: 'RUNNING' },
      include: { flow: { select: { name: true } } },
    });
    return row ? this.toRunning(row) : null;
  }

  private toRunning(row: SessionRow & { flow: { name: string } }) {
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
    const after: AfterCommit = { numberId: '', conversationId, sendItemIds: [], timers: [], apiCalls: [], touched: false, contactChanged: null, requested: false, noteIds: [] };
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
      render: (text, fallbacks, answers, saved) =>
        renderFlowText(text, saved ? { ...contact, attributes: { ...contact.attributes, ...saved } } : contact, fallbacks, answers),
      answers: input.kind === 'message' ? await this.answerContext() : { today: todayIn('UTC'), normalizePhone: () => null },
      ...(flow.graph.steps.some((st) => st.type === 'condition' || st.type === 'attributes') ? { facts: await this.factsFor(tx, row, contact) } : {}),
    });
    await this.apply(tx, row, flow, result, conversation.lastCustomerMessageAt, after);
  }

  /** What conditions and attribute steps read: contact name and phone, attributes, tags, consent, working hours. */
  private async factsFor(tx: Tx, row: SessionRow, contact: { name: string | null; phoneE164: string | null; attributes: Record<string, unknown> }): Promise<FlowFacts> {
    const [tags, consent, liveChat] = await Promise.all([
      row.contactId ? tx.contactTag.findMany({ where: { contactId: row.contactId }, select: { tagId: true } }) : Promise.resolve([]),
      row.contactId ? tx.contact.findUnique({ where: { id: row.contactId }, select: { consentStatus: true } }) : Promise.resolve(null),
      this.liveChat.get(),
    ]);
    return {
      fields: { name: contact.name, phone: contact.phoneE164 },
      attributes: contact.attributes,
      tagIds: tags.map((t) => t.tagId),
      consent: consent?.consentStatus ?? 'UNKNOWN',
      workingHours: { hours: liveChat.workingHours, timezone: liveChat.timezone },
      now: new Date(),
    };
  }

  /** Only customer messages are checked as answers, so only they need the company settings. */
  private async answerContext(): Promise<AnswerContext> {
    const [company, liveChat] = await Promise.all([this.settings.get(), this.liveChat.get()]);
    return {
      today: todayIn(liveChat.timezone),
      normalizePhone: (input) => normalizePhone(input, company.defaultCountryCode)?.e164 ?? null,
    };
  }

  private async apply(tx: Tx, row: SessionRow, flow: FlowMeta, result: RunResult, lastCustomerMessageAt: Date | null, after: AfterCommit): Promise<void> {
    const now = new Date();
    let state = result.state;
    let ended: { result: FlowSessionResult; reason?: string } | null = null;
    /** The flow a jump continues in, started once this session has ended. */
    let jumpTo: FlowMeta | null = null;
    const openRows = new Map<string, bigint>();

    for (const effect of result.effects) {
      if (ended) break;
      switch (effect.kind) {
        case 'stepEntered': {
          if (row.isTest) break;
          this.metrics.flowStepsTotal.inc({ type: flow.graph.steps.find((s) => s.id === effect.stepId)?.type ?? 'unknown' });
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
          await this.saveAttributes(tx, row, flow, effect.values, after);
          break;
        case 'handover':
          await this.handOver(tx, row, flow, effect.note, now, after);
          break;
        case 'tags':
          await this.saveTags(tx, row, flow, effect.add, effect.remove, after);
          break;
        case 'jump':
          jumpTo = await this.jumpTarget(effect.flowId, row.isTest);
          if (!jumpTo) ended = { result: 'FAILED', reason: 'the flow to continue in is not published' };
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
      if (!row.isTest) this.metrics.flowSessionsTotal.inc({ result: ended.result });
      if (jumpTo && ended.result === 'COMPLETED') {
        await this.createAndRun(
          tx,
          jumpTo,
          {
            flowId: jumpTo.id,
            versionId: jumpTo.versionId,
            conversationId: row.conversationId,
            startedBy: 'JUMP',
            parentSessionId: row.id,
            isTest: row.isTest,
            answers: state.answers,
            stepsSinceInput: state.stepsSinceInput,
          },
          after,
        );
      }
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
    if (!row.isTest) this.metrics.flowSessionsTotal.inc({ result });
    const flow = await tx.flow.findUnique({ where: { id: row.flowId }, select: { name: true } });
    await this.endJourney(tx, row, flow?.name ?? '', result);
  }

  private async endJourney(tx: Tx, row: SessionRow, flowName: string, result: FlowSessionResult): Promise<void> {
    if (!row.contactId) return;
    await tx.conversationEvent.create({
      data: { conversationId: row.conversationId, type: 'FLOW_ENDED', actorType: 'FLOW', data: { flowId: row.flowId, flowName, result, test: row.isTest } },
    });
  }

  /**
   * Saves answers to contact attributes with the 001 type rules (FR-010) and records a journey entry
   * by the flow on each of the contact's chats, as live chat edits do (002 FR-033). A value that no
   * longer fits (attribute deleted or retyped after publishing) is skipped with a warning.
   */
  private async saveAttributes(tx: Tx, row: SessionRow, flow: FlowMeta, values: Record<string, string | number | null>, after: AfterCommit): Promise<void> {
    if (!row.contactId) return;
    const keys = Object.keys(values);
    const [definitions, contact] = await Promise.all([
      tx.attributeDefinition.findMany({ where: { key: { in: keys } }, select: { key: true, type: true } }),
      tx.contact.findUnique({ where: { id: row.contactId }, select: { attributes: true } }),
    ]);
    if (!contact) return;
    const typeOf = new Map(definitions.map((d) => [d.key, d.type]));
    const attributes = { ...((contact.attributes ?? {}) as Record<string, unknown>) };
    const changes: Array<{ key: string; from: unknown; to: AttributeValue | null }> = [];
    for (const [key, raw] of Object.entries(values)) {
      const type = typeOf.get(key);
      const checked = type && raw !== null ? validateAttributeValue(type, raw) : null;
      if (!type || (checked && !checked.ok)) {
        this.logger.warn({ sessionId: row.id, attribute: key }, 'Flow answer does not fit the contact attribute; not saved');
        continue;
      }
      const to = checked?.ok ? checked.value : null;
      const from = attributes[key] ?? null;
      if (JSON.stringify(from) === JSON.stringify(to)) continue;
      if (to === null) delete attributes[key];
      else attributes[key] = to;
      changes.push({ key, from, to });
    }
    if (!changes.length) return;
    await tx.contact.update({ where: { id: row.contactId }, data: { attributes: attributes as Prisma.InputJsonValue } });
    const chats = await tx.conversation.findMany({ where: { contactId: row.contactId }, select: { id: true } });
    const occurredAt = new Date();
    await tx.conversationEvent.createMany({
      data: changes.flatMap((change) =>
        chats.map((chat) => ({
          conversationId: chat.id,
          type: 'ATTRIBUTE_CHANGED' as const,
          actorType: 'FLOW' as const,
          data: { key: change.key, from: change.from, to: change.to, flowId: flow.id, flowName: flow.name } as Prisma.InputJsonValue,
          occurredAt,
        })),
      ),
    });
    after.contactChanged = row.contactId;
  }

  /** The published version a jump continues in (a test run continues in the draft); null when not available. */
  private async jumpTarget(flowId: string, isTest: boolean): Promise<FlowMeta | null> {
    const target = await this.prisma.flow.findUnique({ where: { id: flowId }, select: { status: true, publishedVersionId: true, deletedAt: true } });
    if (!target || target.deletedAt) return null;
    if (isTest) return this.loadFlow(flowId, null);
    if (target.status !== 'PUBLISHED' || !target.publishedVersionId) return null;
    return this.loadFlow(flowId, target.publishedVersionId);
  }

  /**
   * Adds and removes contact tags (FR-011) with journey entries by the flow on each of the
   * contact's chats, as live chat edits do; tags deleted since publishing are skipped.
   */
  private async saveTags(tx: Tx, row: SessionRow, flow: FlowMeta, add: string[], remove: string[], after: AfterCommit): Promise<void> {
    if (!row.contactId) return;
    const contactId = row.contactId;
    const [known, current] = await Promise.all([
      tx.tag.findMany({ where: { id: { in: [...add, ...remove] } }, select: { id: true, name: true } }),
      tx.contactTag.findMany({ where: { contactId }, select: { tagId: true } }),
    ]);
    const nameOf = new Map(known.map((t) => [t.id, t.name]));
    const has = new Set(current.map((t) => t.tagId));
    const added = [...new Set(add)].filter((id) => nameOf.has(id) && !has.has(id));
    const removed = [...new Set(remove)].filter((id) => nameOf.has(id) && has.has(id));
    if (!added.length && !removed.length) return;
    if (added.length) await tx.contactTag.createMany({ data: added.map((tagId) => ({ contactId, tagId })), skipDuplicates: true });
    if (removed.length) await tx.contactTag.deleteMany({ where: { contactId, tagId: { in: removed } } });
    const chats = await tx.conversation.findMany({ where: { contactId }, select: { id: true } });
    const occurredAt = new Date();
    const changes = [
      ...added.map((id) => ({ type: 'TAG_ADDED' as const, tag: nameOf.get(id)! })),
      ...removed.map((id) => ({ type: 'TAG_REMOVED' as const, tag: nameOf.get(id)! })),
    ];
    await tx.conversationEvent.createMany({
      data: changes.flatMap((change) =>
        chats.map((chat) => ({ conversationId: chat.id, type: change.type, actorType: 'FLOW' as const, data: { tag: change.tag, flowId: flow.id, flowName: flow.name }, occurredAt })),
      ),
    });
    after.contactChanged = contactId;
  }

  /**
   * Hand-over (FR-027): an Open chat moves to Waiting for agent as if the customer asked, with the
   * 002 alert after commit; the optional note becomes a 002 note in the chat. A member-started
   * session in a chat a member already has just ends.
   */
  private async handOver(tx: Tx, row: SessionRow, flow: FlowMeta, note: string | undefined, now: Date, after: AfterCommit): Promise<void> {
    const moved = await tx.conversation.updateMany({ where: { id: row.conversationId, state: 'ACTIVE' }, data: { state: 'REQUESTING', unresolvedRequests: { increment: 1 } } });
    if (moved.count) {
      await tx.conversationEvent.create({
        data: { conversationId: row.conversationId, type: 'REQUESTED', actorType: 'FLOW', data: { flowId: flow.id, flowName: flow.name }, occurredAt: now },
      });
      after.requested = true;
    }
    if (note) {
      const id = uuidv7();
      await tx.chatMessage.create({
        data: {
          id,
          conversationId: row.conversationId,
          kind: 'NOTE',
          origin: 'AUTOMATIC',
          contentType: 'TEXT',
          text: note,
          payload: { mentions: [], flow: { flowId: flow.id, flowName: flow.name, sessionId: row.id, test: row.isTest } },
          occurredAt: now,
        },
      });
      after.noteIds.push(id);
    }
    after.touched = true;
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
      for (const noteId of after.noteIds) await this.publisher.itemCreated(noteId);
      if (after.touched) {
        await this.publisher.conversation(after.conversationId, after.requested ? { state: 'ACTIVE', intervenedById: null, blocked: false } : undefined);
      }
      if (after.requested) await this.routing.alertRequesting(after.conversationId);
      if (after.contactChanged) await this.publisher.contactUpdated(after.contactChanged);
      for (const timer of after.timers) await this.queueTimer(timer);
      for (const call of after.apiCalls) await this.queueApiCall(call);
    } catch (error) {
      this.logger.error({ err: (error as Error).message, conversationId: after.conversationId }, 'Could not queue flow work after commit');
    }
  }

  /** Delayed `flow-timer` job carrying the wait token (research R10); a newer wait makes it stale. */
  protected async queueTimer(timer: AfterCommit['timers'][number]): Promise<void> {
    const data: FlowTimerData = { sessionId: timer.sessionId, token: timer.token };
    await this.queues
      .get(QUEUES.FLOWS)
      .add(FLOW_TIMER_JOB, data, { delay: timer.delayMs, jobId: flowTimerJobId(data), removeOnComplete: true, removeOnFail: 100 });
  }

  /** `flow-api` job for the API step the session waits at (research R11). */
  protected async queueApiCall(call: AfterCommit['apiCalls'][number]): Promise<void> {
    const data: FlowApiData = { sessionId: call.sessionId, token: call.token };
    await this.queues.get(QUEUES.FLOWS).add(FLOW_API_JOB, data, { jobId: flowApiJobId(data), removeOnComplete: true, removeOnFail: 100 });
  }
}
