'use client';

import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { AdBuilder } from '@/components/ads/ad-builder';
import { RequirePermission } from '@/components/require-permission';
import { adsKeys, type AdCampaign } from '@/lib/ads';
import { api } from '@/lib/api-client';

/** Ads > New ad, also used to edit drafts with ?id= (feature 007 US2, T031). */
export default function NewAdPage() {
  return (
    <RequirePermission permission="campaigns.manage">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
        <NewAd />
      </Suspense>
    </RequirePermission>
  );
}

function NewAd() {
  const id = useSearchParams().get('id');
  const campaign = useQuery({ queryKey: adsKeys.campaign(id ?? ''), queryFn: () => api<AdCampaign>(`/ads/campaigns/${id}`), enabled: Boolean(id) });
  return (
    <div className="grid gap-4">
      <div>
        <Link href={id ? `/ads/${id}` : '/ads'} className="text-sm text-muted-foreground hover:underline">
          ← {id ? 'Campaign' : 'Ads'}
        </Link>
        <h1 className="text-2xl font-semibold">{id ? 'Edit draft' : 'New ad'}</h1>
      </div>
      {id && campaign.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
      {!id ? <AdBuilder /> : campaign.data ? <AdBuilder campaign={campaign.data} /> : null}
    </div>
  );
}
