import type { ConversationState } from '../inbox-common.js';

// Pure state rules for a chat (specs/002-team-inbox/data-model.md §4, FR-019-FR-025). The services
// apply them with conditional UPDATEs, so concurrent callers still get exactly one winner (R6).

export interface ConversationSnapshot {
  state: ConversationState;
  intervenedById: string | null;
}

/** The member acting; `canMonitor` (admins and managers) may act on chats other members took. */
export interface Actor {
  id: string;
  canMonitor: boolean;
}

export type TransitionError = 'ALREADY_TAKEN' | 'NOT_INTERVENED' | 'NOT_OWNER';

export type Transition =
  | { ok: true; changed: boolean; next: ConversationSnapshot }
  | { ok: false; error: TransitionError; ownerId: string | null };

export interface CustomerMessageOutcome {
  next: ConversationSnapshot;
  /** Adds one to the unresolved-requests count (FR-021). */
  countRequest: boolean;
  /** The chat has just started waiting for an agent: notify the members who can see it. */
  becameRequesting: boolean;
}

const active = (): ConversationSnapshot => ({ state: 'ACTIVE', intervenedById: null });
const requesting = (): ConversationSnapshot => ({ state: 'REQUESTING', intervenedById: null });
const intervenedBy = (userId: string): ConversationSnapshot => ({ state: 'INTERVENED', intervenedById: userId });

/**
 * What a customer message does to the chat. `current` is null for a new chat; `windowWasOpen`
 * tells whether the message arrived inside the previous 24-hour window.
 */
export function onCustomerMessage(
  current: ConversationSnapshot | null,
  input: { humanKeyword: boolean; windowWasOpen: boolean },
): CustomerMessageOutcome {
  const { humanKeyword, windowWasOpen } = input;
  // An owner keeps the chat, even after the window closed (FR-024); a keyword is only counted.
  if (current?.state === 'INTERVENED') return { next: { ...current }, countRequest: humanKeyword, becameRequesting: false };
  if (humanKeyword) {
    const alreadyWaiting = current?.state === 'REQUESTING' && windowWasOpen;
    return { next: requesting(), countRequest: true, becameRequesting: !alreadyWaiting };
  }
  // A request is kept while the window is open; a new window starts without it.
  if (current?.state === 'REQUESTING' && windowWasOpen) return { next: requesting(), countRequest: false, becameRequesting: false };
  return { next: active(), countRequest: false, becameRequesting: false };
}

/** Take chat: one owner at a time; repeating it as the owner changes nothing. */
export function intervene(current: ConversationSnapshot, actor: Actor): Transition {
  if (current.state === 'INTERVENED') {
    if (current.intervenedById === actor.id) return { ok: true, changed: false, next: { ...current } };
    return { ok: false, error: 'ALREADY_TAKEN', ownerId: current.intervenedById };
  }
  return { ok: true, changed: true, next: intervenedBy(actor.id) };
}

/** Hands a taken chat to another member: the owner, an admin or a manager may do it (FR-022). */
export function transfer(current: ConversationSnapshot, actor: Actor, targetUserId: string): Transition {
  const guard = ownerGuard(current, actor);
  if (guard) return guard;
  if (current.intervenedById === targetUserId) return { ok: true, changed: false, next: { ...current } };
  return { ok: true, changed: true, next: intervenedBy(targetUserId) };
}

/** Close chat: ends the intervention and returns the chat to ACTIVE (FR-023). */
export function resolve(current: ConversationSnapshot, actor: Actor): Transition {
  return ownerGuard(current, actor) ?? { ok: true, changed: true, next: active() };
}

/** Auto-resolve and member deactivation (FR-024, FR-025); null when there is nothing to resolve. */
export function autoResolve(current: ConversationSnapshot): ConversationSnapshot | null {
  return current.state === 'INTERVENED' ? active() : null;
}

function ownerGuard(current: ConversationSnapshot, actor: Actor): Transition | null {
  if (current.state !== 'INTERVENED') return { ok: false, error: 'NOT_INTERVENED', ownerId: null };
  if (current.intervenedById !== actor.id && !actor.canMonitor) return { ok: false, error: 'NOT_OWNER', ownerId: current.intervenedById };
  return null;
}
