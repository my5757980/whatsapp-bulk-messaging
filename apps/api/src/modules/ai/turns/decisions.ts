import type { AgentReply } from '@wbm/shared';

// Pure rules for whom the agent may answer and when it hands over (004 US2: FR-016, FR-023,
// research R12). The turn service gathers the facts; these functions decide.

export interface EligibilityFacts {
  /** 002 chat state; only ACTIVE (Open) chats are answered. */
  state: string;
  blocked: boolean;
  optedOut: boolean;
  /** The customer's 24-hour window is open. */
  windowLive: boolean;
  /** A flow session is running in the chat, so the flow answers. */
  flowRunning: boolean;
}

export type Ineligible = 'BLOCKED' | 'OPTED_OUT' | 'NOT_OPEN' | 'WINDOW_CLOSED' | 'FLOW_RUNNING';

/** Why the agent may not answer the chat now, or null when it may (FR-016). */
export function ineligibility(facts: EligibilityFacts): Ineligible | null {
  if (facts.blocked) return 'BLOCKED';
  if (facts.optedOut) return 'OPTED_OUT';
  if (facts.state !== 'ACTIVE') return 'NOT_OPEN';
  if (!facts.windowLive) return 'WINDOW_CLOSED';
  if (facts.flowRunning) return 'FLOW_RUNNING';
  return null;
}

export type HandOverReason = NonNullable<AgentReply['handOver']>['reason'] | 'cap';

export interface HandOver {
  reason: HandOverReason;
  summary: string;
  /** Decided by our rules rather than asked for by the model. */
  forced: boolean;
}

/** The AI conversation has had as many replies as the agent allows (FR-023). */
export function capReached(replies: number, replyCap: number): boolean {
  return replies >= replyCap;
}

export interface HandOverRules {
  whenUnsure: 'say_so' | 'hand_over';
  /** Questions this AI conversation already could not answer. */
  unansweredBefore: number;
  /** The reply cap was reached before this turn. */
  capReached: boolean;
}

/**
 * The hand-over a reply leads to (FR-023, research R12): the one the model asked for; else the
 * reply cap; else a second question the AI conversation could not answer; else "hand over when
 * unsure". An opt-out sends nothing, so it never hands over.
 */
export function handOverFor(reply: AgentReply, rules: HandOverRules): HandOver | null {
  if (reply.optOut === 'clear') return null;
  if (reply.handOver) return { reason: reply.handOver.reason, summary: reply.handOver.summary, forced: false };
  if (rules.capReached) return { reason: 'cap', summary: '', forced: true };
  if (reply.unanswered && rules.unansweredBefore > 0) return { reason: 'repeat', summary: `Could not answer again: ${reply.unanswered}`, forced: true };
  if (reply.unanswered && rules.whenUnsure === 'hand_over') return { reason: 'unsure', summary: `Could not answer: ${reply.unanswered}`, forced: true };
  return null;
}

const REASON_LABELS: Record<HandOverReason, string> = {
  customer_asked: 'The customer asked for a person',
  topic: 'The message is about a hand-over topic',
  unsure: 'The agent could not answer',
  repeat: 'The agent could not answer a second question',
  cap: 'The conversation reached the reply limit',
  other: 'The agent handed the chat over',
};

/** Why the agent handed over, in words for the team. */
export function handOverReason(reason: HandOverReason): string {
  return REASON_LABELS[reason];
}

/** The team's note in the chat: why the agent handed over, then the summary (FR-024). */
export function handOverNote(agentName: string, handOver: HandOver): string {
  const summary = handOver.summary.trim();
  return `${agentName} handed this chat over. ${REASON_LABELS[handOver.reason]}.${summary ? `\n${summary}` : ''}`;
}

/** The team's note when the AI service failed (FR-022). */
export const UNAVAILABLE_NOTE = 'AI agent unavailable: the fallback message was sent and the chat waits for a person.';
