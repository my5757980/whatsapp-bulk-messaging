'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState, type ReactNode } from 'react';
import { ApiError } from './api-client';

/** Query keys in one place so invalidation stays consistent (T067). */
export const queryKeys = {
  me: ['me'] as const,
  notifications: ['notifications'] as const,
  numbers: ['numbers'] as const,
  templates: (filters?: Record<string, string>) => ['templates', filters ?? {}] as const,
  campaigns: (filters?: Record<string, string | number>) => ['campaigns', filters ?? {}] as const,
  campaign: (id: string) => ['campaign', id] as const,
  campaignMessages: (id: string, filters?: Record<string, string | number>) => ['campaign', id, 'messages', filters ?? {}] as const,
  contacts: (filters?: Record<string, unknown>) => ['contacts', filters ?? {}] as const,
  contact: (id: string) => ['contact', id] as const,
  tags: ['tags'] as const,
  attributes: ['attributes'] as const,
  audiencePreview: (body: unknown) => ['audience-preview', body] as const,
  settings: ['settings'] as const,
  // Live chat (feature 002): everything under ['inbox'] is refreshed together on resync.
  inbox: ['inbox'] as const,
  inboxLists: ['inbox', 'conversations'] as const,
  inboxConversations: (filters?: Record<string, unknown>) => ['inbox', 'conversations', filters ?? {}] as const,
  inboxConversation: (id: string) => ['inbox', 'conversation', id] as const,
  inboxItems: (id: string) => ['inbox', 'items', id] as const,
  inboxUnread: ['inbox', 'unread'] as const,
  notificationPrefs: ['notification-preferences'] as const,
  pushDevices: ['push-devices'] as const,
};

export function QueryProvider({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 10_000,
            refetchOnWindowFocus: false,
            // Do not retry client errors (401/403/404/422); retry transient failures twice.
            retry: (failureCount, error) =>
              !(error instanceof ApiError && error.status < 500) && failureCount < 2,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
