'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from '@/components/ui/toaster';
import { AD_STATUS_LABEL, adsKeys, type AdCampaign, type AdCampaignSummary } from '@/lib/ads';
import { api } from '@/lib/api-client';
import { errorMessage } from '@/lib/errors';
import { usePermissions } from '@/lib/permissions';

const OPEN_STATES = new Set(['DRAFT', 'IN_REVIEW', 'ACTIVE', 'PAUSED', 'REJECTED', 'ERROR']);

/**
 * The flow builder's Ads trigger (feature 007 US3, FR-022): the flow answers the first message of chats
 * from the chosen Click-to-WhatsApp campaigns. Choosing sets the campaign's flow, so each campaign has one.
 */
export function AdsTriggerCard({ flowId, published }: { flowId: string; published: boolean }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const enabled = can('campaigns.view');
  const campaigns = useQuery({ queryKey: adsKeys.campaigns, queryFn: () => api<AdCampaignSummary[]>('/ads/campaigns'), enabled });
  const chats = (campaigns.data ?? []).filter((c) => c.goal === 'CHATS' && OPEN_STATES.has(c.status));
  const details = useQuery({
    queryKey: [...adsKeys.campaigns, 'flows', chats.map((c) => c.id).join(',')],
    queryFn: async () => Promise.all(chats.map((c) => api<AdCampaign>(`/ads/campaigns/${c.id}`))),
    enabled: enabled && chats.length > 0,
  });
  const toggle = useMutation({
    mutationFn: ({ id, on }: { id: string; on: boolean }) => api<AdCampaign>(`/ads/campaigns/${id}`, { method: 'PATCH', json: { flowId: on ? flowId : null } }),
    onSuccess: async (_, { on }) => {
      toast.success(on ? 'This flow now answers chats from the campaign' : 'The campaign no longer starts this flow');
      await queryClient.invalidateQueries({ queryKey: adsKeys.campaigns });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (!enabled) return null;
  return (
    <section aria-labelledby="ads-trigger-title" className="grid gap-2 rounded-lg border bg-card p-3" data-testid="ads-trigger-card">
      <h2 id="ads-trigger-title" className="text-sm font-semibold">
        Ads
      </h2>
      <p className="text-xs text-muted-foreground">Answer the first message of chats from Click-to-WhatsApp ads. A running flow or a member&apos;s chat is never interrupted.</p>
      {!published ? <p className="text-xs text-muted-foreground">Publish the flow to choose campaigns.</p> : null}
      {published && campaigns.isSuccess && !chats.length ? (
        <p className="text-xs text-muted-foreground">
          No chat ad campaigns yet. <Link href="/ads/new" className="underline">Make one</Link>
        </p>
      ) : null}
      {published
        ? (details.data ?? []).map((c) => {
            const mine = c.flowId === flowId;
            return (
              <label key={c.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  checked={mine}
                  disabled={!can('campaigns.manage') || toggle.isPending}
                  onChange={(e) => toggle.mutate({ id: c.id, on: e.target.checked })}
                  aria-label={`Start this flow from ${c.name}`}
                />
                <span className="truncate">{c.name}</span>
                <span className="text-xs text-muted-foreground">· {AD_STATUS_LABEL[c.status]}</span>
                {c.flowId && !mine ? <span className="text-xs text-amber-600">(another flow)</span> : null}
              </label>
            );
          })
        : null}
    </section>
  );
}
