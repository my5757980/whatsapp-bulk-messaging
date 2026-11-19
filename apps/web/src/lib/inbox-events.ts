'use client';

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect } from 'react';
import { queryKeys } from './query';

// Live chat events in the browser (specs/002-team-inbox/contracts/realtime-events.md, T023): one
// EventSource per signed-in tab on every dashboard page, so badges and sound work everywhere.
// Events refresh the TanStack Query caches; actions stay ordinary REST calls.

export const INBOX_EVENT_TYPES = [
  'conversation.upserted',
  'message.created',
  'message.status',
  'note.created',
  'conversation.window_closed',
  'contact.updated',
  'resync',
] as const;

export type InboxEventType = (typeof INBOX_EVENT_TYPES)[number];

export interface InboxEvent {
  /** Stream entry ID (also sent back as Last-Event-ID on reconnect). */
  id: string;
  type: InboxEventType;
  data: Record<string, unknown>;
}

type Listener = (event: InboxEvent) => void;

const listeners = new Set<Listener>();

/** Lets components react to events (sound, the open chat, scroll). Returns the unsubscribe function. */
export function subscribeInboxEvents(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Failed reconnects after which the lists are refetched over REST. */
const REFETCH_AFTER_FAILURES = 5;
const MAX_BACKOFF_MS = 30_000;

/** Opens the live event stream while `enabled` (signed in with inbox.view). */
export function useInboxEvents(enabled: boolean): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!enabled || typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    let source: EventSource | null = null;
    let failures = 0;
    let retryTimer: number | undefined;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      // Same origin through the Next.js /api proxy; the session cookie authenticates it.
      source = new EventSource('/api/inbox/events');
      source.onopen = () => {
        // Back after an outage longer than the browser's own retries: refetch what was missed.
        if (failures > 0) refreshAll(queryClient);
        failures = 0;
      };
      for (const type of INBOX_EVENT_TYPES) {
        source.addEventListener(type, (message) => handle(queryClient, type, message as MessageEvent<string>));
      }
      source.onerror = () => {
        // While the connection merely drops, EventSource retries by itself and resends
        // Last-Event-ID. Once it gives up (CLOSED: e.g. a 401 or 502), reconnect with backoff.
        if (source?.readyState !== EventSource.CLOSED) return;
        source.close();
        failures += 1;
        if (failures === REFETCH_AFTER_FAILURES) refreshAll(queryClient);
        retryTimer = window.setTimeout(connect, Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** failures));
      };
    };

    connect();
    return () => {
      stopped = true;
      window.clearTimeout(retryTimer);
      source?.close();
    };
  }, [enabled, queryClient]);
}

function handle(queryClient: QueryClient, type: InboxEventType, message: MessageEvent<string>): void {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(message.data) as Record<string, unknown>;
  } catch {
    return;
  }
  const event: InboxEvent = { id: message.lastEventId, type, data };
  applyToCaches(queryClient, event);
  for (const listener of listeners) listener(event);
}

/** Refreshes the affected queries; only the ones on screen refetch (TanStack Query default). */
function applyToCaches(queryClient: QueryClient, event: InboxEvent): void {
  const conversationId = typeof event.data.conversationId === 'string' ? event.data.conversationId : undefined;
  switch (event.type) {
    case 'resync':
      refreshAll(queryClient);
      return;
    case 'message.created':
    case 'message.status':
    case 'note.created':
      if (conversationId) void queryClient.invalidateQueries({ queryKey: queryKeys.inboxItems(conversationId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxUnread });
      return;
    case 'contact.updated':
      for (const id of Array.isArray(event.data.conversationIds) ? (event.data.conversationIds as string[]) : []) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(id) });
        void queryClient.invalidateQueries({ queryKey: ['journey', id] });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
      return;
    case 'conversation.upserted':
    case 'conversation.window_closed':
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxLists });
      void queryClient.invalidateQueries({ queryKey: queryKeys.inboxUnread });
      if (conversationId) void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(conversationId) });
      if (event.type === 'conversation.upserted' && typeof event.data.id === 'string') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.inboxConversation(event.data.id) });
      }
      return;
  }
}

function refreshAll(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.inbox });
}
