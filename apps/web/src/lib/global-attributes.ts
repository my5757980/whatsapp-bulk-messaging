'use client';

// Feature 010 (US3, contracts/contacts-settings-api.openapi.yaml tag global-attributes): company-wide values
// used as `{global:key}` in texts and as the `global` source of template variables.
import { useQuery } from '@tanstack/react-query';
import { api } from './api-client';

export interface GlobalAttribute {
  id: string;
  key: string;
  description: string | null;
  value: string;
  updatedBy: string | null;
  updatedAt: string;
}

export type GlobalUsageKind = 'CAMPAIGN' | 'SAVED_REPLY' | 'FLOW' | 'AI_AGENT' | 'DATE_AUTOMATION' | 'KEYWORD_REPLY';

export const GLOBAL_USAGE_LABELS: Record<GlobalUsageKind, string> = {
  CAMPAIGN: 'Campaign',
  SAVED_REPLY: 'Saved reply',
  FLOW: 'Flow',
  AI_AGENT: 'AI agent',
  DATE_AUTOMATION: 'Date automation',
  KEYWORD_REPLY: 'Keyword reply',
};

export const globalAttributesKey = ['global-attributes'] as const;

/** The placeholder members type into texts. */
export const globalPlaceholder = (key: string) => `{global:${key}}`;

/** Every global attribute with its value (all roles can read them). */
export function useGlobalAttributes(enabled = true) {
  return useQuery({ queryKey: globalAttributesKey, queryFn: () => api<{ items: GlobalAttribute[] }>('/global-attributes'), enabled, staleTime: 30_000 });
}
