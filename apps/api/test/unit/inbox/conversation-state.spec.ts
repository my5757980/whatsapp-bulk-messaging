import { describe, expect, it } from 'vitest';
import {
  autoResolve,
  intervene,
  onCustomerMessage,
  resolve,
  transfer,
  type ConversationSnapshot,
} from '../../../src/modules/inbox/conversations/conversation-state.js';

// T006: conversation state transitions (specs/002-team-inbox/data-model.md §4, FR-019-FR-025).
const active: ConversationSnapshot = { state: 'ACTIVE', intervenedById: null };
const requesting: ConversationSnapshot = { state: 'REQUESTING', intervenedById: null };
const takenByA: ConversationSnapshot = { state: 'INTERVENED', intervenedById: 'user-a' };

const agentA = { id: 'user-a', canMonitor: false };
const agentB = { id: 'user-b', canMonitor: false };
const manager = { id: 'manager', canMonitor: true };

describe('customer messages', () => {
  it('a first message opens an ACTIVE chat', () => {
    expect(onCustomerMessage(null, { humanKeyword: false, windowWasOpen: false })).toEqual({
      next: active,
      countRequest: false,
      becameRequesting: false,
    });
  });

  it('a first message that is a "talk to a person" keyword opens a REQUESTING chat', () => {
    expect(onCustomerMessage(null, { humanKeyword: true, windowWasOpen: false })).toEqual({
      next: requesting,
      countRequest: true,
      becameRequesting: true,
    });
  });

  it('a keyword moves an ACTIVE chat to REQUESTING and counts the request', () => {
    expect(onCustomerMessage(active, { humanKeyword: true, windowWasOpen: true })).toEqual({
      next: requesting,
      countRequest: true,
      becameRequesting: true,
    });
  });

  it('a keyword in an INTERVENED chat only counts the request', () => {
    expect(onCustomerMessage(takenByA, { humanKeyword: true, windowWasOpen: true })).toEqual({
      next: takenByA,
      countRequest: true,
      becameRequesting: false,
    });
  });

  it('a repeated keyword in a REQUESTING chat counts again without becoming REQUESTING again', () => {
    expect(onCustomerMessage(requesting, { humanKeyword: true, windowWasOpen: true })).toEqual({
      next: requesting,
      countRequest: true,
      becameRequesting: false,
    });
  });

  it('a plain message keeps the state while the window is open', () => {
    for (const current of [active, requesting, takenByA]) {
      expect(onCustomerMessage(current, { humanKeyword: false, windowWasOpen: true }).next).toEqual(current);
    }
  });

  it('after the window closed, REQUESTING becomes ACTIVE unless the new message is a keyword', () => {
    expect(onCustomerMessage(requesting, { humanKeyword: false, windowWasOpen: false }).next).toEqual(active);
    expect(onCustomerMessage(requesting, { humanKeyword: true, windowWasOpen: false })).toEqual({
      next: requesting,
      countRequest: true,
      becameRequesting: true,
    });
  });

  it('after the window closed, an INTERVENED chat returns to the same member', () => {
    expect(onCustomerMessage(takenByA, { humanKeyword: false, windowWasOpen: false }).next).toEqual(takenByA);
  });
});

describe('Intervene', () => {
  it('takes an ACTIVE or REQUESTING chat', () => {
    expect(intervene(active, agentA)).toEqual({ ok: true, changed: true, next: takenByA });
    expect(intervene(requesting, agentA)).toEqual({ ok: true, changed: true, next: takenByA });
  });

  it('refuses a chat another member already took, naming the owner', () => {
    expect(intervene(takenByA, agentB)).toEqual({ ok: false, error: 'ALREADY_TAKEN', ownerId: 'user-a' });
    expect(intervene(takenByA, manager)).toEqual({ ok: false, error: 'ALREADY_TAKEN', ownerId: 'user-a' });
  });

  it('is a no-op for the current owner', () => {
    expect(intervene(takenByA, agentA)).toEqual({ ok: true, changed: false, next: takenByA });
  });
});

describe('transfer', () => {
  it('lets the owner hand the chat to another member', () => {
    expect(transfer(takenByA, agentA, 'user-b')).toEqual({ ok: true, changed: true, next: { state: 'INTERVENED', intervenedById: 'user-b' } });
  });

  it('lets admins and managers transfer any intervened chat', () => {
    expect(transfer(takenByA, manager, 'user-b')).toEqual({ ok: true, changed: true, next: { state: 'INTERVENED', intervenedById: 'user-b' } });
  });

  it('refuses agents who do not own the chat', () => {
    expect(transfer(takenByA, agentB, 'user-b')).toEqual({ ok: false, error: 'NOT_OWNER', ownerId: 'user-a' });
  });

  it('refuses chats nobody has taken', () => {
    expect(transfer(active, manager, 'user-b')).toEqual({ ok: false, error: 'NOT_INTERVENED', ownerId: null });
    expect(transfer(requesting, manager, 'user-b')).toEqual({ ok: false, error: 'NOT_INTERVENED', ownerId: null });
  });

  it('changes nothing when the target already owns it', () => {
    expect(transfer(takenByA, manager, 'user-a')).toEqual({ ok: true, changed: false, next: takenByA });
  });
});

describe('resolve', () => {
  it('returns the owner or a manager to ACTIVE', () => {
    expect(resolve(takenByA, agentA)).toEqual({ ok: true, changed: true, next: active });
    expect(resolve(takenByA, manager)).toEqual({ ok: true, changed: true, next: active });
  });

  it('refuses agents who do not own the chat', () => {
    expect(resolve(takenByA, agentB)).toEqual({ ok: false, error: 'NOT_OWNER', ownerId: 'user-a' });
  });

  it('refuses chats nobody has taken', () => {
    expect(resolve(active, manager)).toEqual({ ok: false, error: 'NOT_INTERVENED', ownerId: null });
  });
});

describe('auto-resolve and deactivation', () => {
  it('returns an INTERVENED chat to ACTIVE', () => {
    expect(autoResolve(takenByA)).toEqual(active);
  });

  it('leaves chats nobody has taken alone', () => {
    expect(autoResolve(active)).toBeNull();
    expect(autoResolve(requesting)).toBeNull();
  });
});
