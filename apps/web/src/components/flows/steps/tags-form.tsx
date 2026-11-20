'use client';

import { useQuery } from '@tanstack/react-query';
import { FLOW_LIMITS, type FlowGraph, type StepOf } from '@wbm/shared';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query';
import type { Tag } from '@/lib/types';
import { GoesToSelect } from './goes-to-select';
import type { StepPatch } from './step-form';

type TagsStep = StepOf<'tags'>;

/** Tags step (FR-011): add and remove contact tags; a tag is either added or removed, not both. */
export function TagsForm({ step, graph, onPatch }: { step: TagsStep; graph: FlowGraph; onPatch: StepPatch<TagsStep> }) {
  const tags = useQuery({ queryKey: queryKeys.tags, queryFn: () => api<Tag[]>('/tags') });

  function toggle(list: 'add' | 'remove', id: string, on: boolean) {
    const next = on ? [...new Set([...step[list], id])].slice(0, FLOW_LIMITS.tagsPerStep) : step[list].filter((t) => t !== id);
    const without = (ids: string[]) => ids.filter((t) => t !== id);
    onPatch(list === 'add' ? { add: next, remove: without(step.remove) } : { remove: next, add: without(step.add) });
  }

  return (
    <div className="grid gap-3">
      {(['add', 'remove'] as const).map((list) => (
        <fieldset key={list} className="grid gap-1">
          <legend className="mb-1 text-sm font-medium">{list === 'add' ? 'Add these tags' : 'Remove these tags'}</legend>
          {tags.data?.length === 0 && <p className="text-xs text-muted-foreground">There are no tags yet.</p>}
          <div className="grid max-h-40 gap-1 overflow-y-auto">
            {tags.data?.map((tag) => (
              <label key={tag.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  aria-label={`${list === 'add' ? 'Add' : 'Remove'} tag ${tag.name}`}
                  checked={step[list].includes(tag.id)}
                  onChange={(e) => toggle(list, tag.id, e.target.checked)}
                />
                {tag.name}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <GoesToSelect id="tags-next" label="Then go to" graph={graph} fromId={step.id} value={step.next} onChange={(next) => onPatch({ next })} />
    </div>
  );
}
