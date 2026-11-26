// What a run of the flow engine asks the session service to do (003 research R4). Effects are plain
// data so the interpreter stays pure and every step type can be unit tested.

/** Results of a finished session (data-model.md §3). */
export type FlowSessionResult =
  | 'COMPLETED'
  | 'HANDED_OVER'
  | 'TIMED_OUT'
  | 'STOPPED_BY_MEMBER'
  | 'OPTED_OUT'
  | 'INTERRUPTED'
  | 'WINDOW_CLOSED'
  | 'SEND_FAILED'
  | 'FLOW_UNPUBLISHED'
  | 'EXPIRED'
  | 'BLOCKED'
  | 'FAILED'
  /** A Hand to AI agent step passed the chat to an AI agent (004 FR-033). */
  | 'HANDED_TO_AI';

/** A message the flow sends (contracts/meta-graph-flows.md); ids of options carry the wait token. */
export type FlowOutboundMessage =
  | { type: 'text'; text: string }
  | { type: 'media'; mediaAssetId: string; caption?: string }
  | { type: 'buttons'; text: string; header?: string; footer?: string; buttons: Array<{ id: string; title: string }> }
  | {
      type: 'list';
      text: string;
      header?: string;
      footer?: string;
      buttonLabel: string;
      sections: Array<{ title?: string; rows: Array<{ id: string; title: string; description?: string }> }>;
    };

export type FlowEffect =
  | { kind: 'stepEntered'; stepId: string }
  | { kind: 'stepLeft'; stepId: string; branch: string }
  | { kind: 'send'; stepId: string; message: FlowOutboundMessage }
  /** Save values to contact attributes (null clears). */
  | { kind: 'setAttributes'; stepId: string; values: Record<string, string | number | null> }
  | { kind: 'tags'; stepId: string; add: string[]; remove: string[] }
  | { kind: 'handover'; stepId: string; note?: string }
  /** A delayed timer carrying the current wait token. */
  | { kind: 'schedule'; stepId: string; purpose: 'delay' | 'timeout'; delayMs: number }
  | { kind: 'callApi'; stepId: string }
  /** Feature 008: ask for a payment; the amount is resolved to the Stripe currency by the payments service. */
  | { kind: 'requestPayment'; stepId: string; amount: { minor: number } | { major: number } | null; description: string; expiryMinutes: number }
  | { kind: 'jump'; stepId: string; flowId: string }
  /** Start the agent's AI conversation in the chat (started by the flow, 004 FR-033). */
  | { kind: 'handToAi'; stepId: string; agentId: string }
  | { kind: 'end'; result: FlowSessionResult; reason?: string };
