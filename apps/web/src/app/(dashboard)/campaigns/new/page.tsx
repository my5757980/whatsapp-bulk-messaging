'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AudienceStep } from '@/components/campaigns/wizard/audience-step';
import { BasicsStep } from '@/components/campaigns/wizard/basics-step';
import { MappingStep } from '@/components/campaigns/wizard/mapping-step';
import { ReviewStep } from '@/components/campaigns/wizard/review-step';
import { RequirePermission } from '@/components/require-permission';
import { api } from '@/lib/api-client';
import { queryKeys } from '@/lib/query';
import type { CampaignDetail } from '@/lib/types';
import { cn } from '@/lib/utils';

const STEPS = ['Basics', 'Audience', 'Variables', 'Review'];

/** New campaign wizard (T109, T110). Progress lives in the URL, so a reload resumes the draft. */
export default function NewCampaignPage() {
  return (
    <RequirePermission permission="campaigns.manage">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <Wizard />
      </Suspense>
    </RequirePermission>
  );
}

function Wizard() {
  const router = useRouter();
  const params = useSearchParams();
  const queryClient = useQueryClient();
  const id = params.get('id');
  const step = Math.min(4, Math.max(1, Number(params.get('step') ?? 1) || 1));
  const go = (campaignId: string, next: number) => router.replace(`/campaigns/new?id=${campaignId}&step=${next}`);

  const campaign = useQuery({
    queryKey: queryKeys.campaign(id ?? 'new'),
    queryFn: () => api<CampaignDetail>(`/campaigns/${id}`),
    enabled: Boolean(id),
  });

  if (id && campaign.isLoading) return <p className="text-sm text-muted-foreground">Loading draft…</p>;
  if (campaign.data && campaign.data.state !== 'DRAFT') {
    router.replace(`/campaigns/${campaign.data.id}`);
    return null;
  }
  const effectiveStep = campaign.data ? step : 1;

  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-2xl font-semibold">{campaign.data ? campaign.data.name : 'New campaign'}</h1>
        <ol className="mt-3 flex flex-wrap gap-2 text-sm" aria-label="Steps">
          {STEPS.map((label, i) => (
            <li
              key={label}
              aria-current={effectiveStep === i + 1 ? 'step' : undefined}
              className={cn('rounded-full border px-3 py-1', effectiveStep === i + 1 ? 'border-primary bg-primary text-primary-foreground' : 'text-muted-foreground')}
            >
              {i + 1}. {label}
            </li>
          ))}
        </ol>
      </div>
      {effectiveStep === 1 ? (
        <BasicsStep
          campaign={campaign.data}
          onSaved={(c) => {
            void queryClient.invalidateQueries({ queryKey: queryKeys.campaign(c.id) });
            go(c.id, 2);
          }}
        />
      ) : null}
      {effectiveStep === 2 && campaign.data ? <AudienceStep campaign={campaign.data} onBack={() => go(campaign.data.id, 1)} onDone={() => go(campaign.data.id, 3)} /> : null}
      {effectiveStep === 3 && campaign.data ? <MappingStep campaign={campaign.data} onBack={() => go(campaign.data.id, 2)} onDone={() => go(campaign.data.id, 4)} /> : null}
      {effectiveStep === 4 && campaign.data ? (
        <ReviewStep
          campaign={campaign.data}
          onBack={() => go(campaign.data.id, 3)}
          onLaunched={(c) => {
            // The cached copy is still the draft; without this the detail page shows "still a draft"
            // (no refetch for 10 s and no polling for drafts) instead of the running or scheduled campaign.
            queryClient.removeQueries({ queryKey: queryKeys.campaign(c.id), exact: true });
            void queryClient.invalidateQueries({ queryKey: ['campaigns'] });
            router.push(`/campaigns/${c.id}`);
          }}
        />
      ) : null}
    </div>
  );
}
