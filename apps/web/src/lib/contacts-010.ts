// Feature 010 web types (contracts/contacts-settings-api.openapi.yaml): segments, bulk actions, lead sources
// and automatic tag rules.
import type { BrokenSegmentRule, LeadSourceKind, SegmentRule, SegmentRules } from '@wbm/shared';

export type { BrokenSegmentRule, LeadSourceKind, SegmentRule, SegmentRules };

export interface Segment {
  id: string;
  name: string;
  description: string | null;
  rules: SegmentRules;
  broken: BrokenSegmentRule[];
  usedBy: Array<{ id: string; name: string; state: string }>;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentCount {
  count: number;
  marketable: number;
  broken: BrokenSegmentRule[];
}

export interface SegmentPreview extends SegmentCount {
  sample: Array<{ id: string; name: string | null; phone: string }>;
}

export interface BulkAction {
  id: string;
  kind: 'TAG_ADD' | 'TAG_REMOVE' | 'DRIP_ENROL';
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED';
  total: number | null;
  processed: number;
  changed: number;
  result: Record<string, number> | null;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export type BulkSelection = { contactIds: string[] } | { filter: { q?: string; tag?: string[]; consent?: string; leadSource?: string } } | { segmentId: string };

export interface AutoTagRule {
  id: string;
  event: 'CONTACT_CREATED' | 'CAMPAIGN_REPLY' | 'LINK_CLICK' | 'OPTED_IN' | 'OPTED_OUT';
  leadSource: LeadSourceKind | null;
  tagId: string;
  tagName: string;
  enabled: boolean;
  createdAt: string;
}

export const contacts010Keys = {
  segments: ['segments'] as const,
  segment: (id: string) => ['segments', id] as const,
  segmentCount: (id: string) => ['segments', id, 'count'] as const,
  bulkAction: (id: string) => ['bulk-actions', id] as const,
  autoTagRules: ['auto-tag-rules'] as const,
};

export const BROKEN_ISSUE_TEXT: Record<BrokenSegmentRule['issue'], string> = {
  TAG_MISSING: 'names a tag that was deleted',
  ATTRIBUTE_MISSING: 'names an attribute that was deleted',
  CAMPAIGN_MISSING: 'names a campaign that no longer exists',
};
