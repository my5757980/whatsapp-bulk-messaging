'use client';

import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import type { AdChat, FreeWindowState } from '@/lib/ads';
import { formatDateTime } from '@/lib/format';

/** Meta's free entry point window, information only (feature 007 FR-023). */
export function FreeWindowBadge({ window }: { window: FreeWindowState }) {
  switch (window.state) {
    case 'REPLY_TO_OPEN':
      return <Badge variant="warning">Reply by {formatDateTime(window.replyBy)} for a free ad window</Badge>;
    case 'OPEN':
      return <Badge variant="success">Free ad window until {formatDateTime(window.until)}</Badge>;
    case 'ENDED':
      return <Badge variant="outline">Free ad window ended {formatDateTime(window.until)}</Badge>;
    default:
      return <Badge variant="outline">No free ad window</Badge>;
  }
}

/** The ad a chat came from, under the chat header (feature 007 US3, FR-021). */
export function AdReferralCard({ adChat }: { adChat: AdChat }) {
  return (
    <div className="flex items-start gap-3 border-b bg-sky-50 px-4 py-2 text-sm dark:bg-sky-950" data-testid="ad-referral-card">
      {adChat.mediaUrl ? (
        // A plain img: the picture is on Meta's CDN and changes per ad, so it is not optimised here.
        <img src={adChat.mediaUrl} alt="" className="size-12 shrink-0 rounded object-cover" referrerPolicy="no-referrer" />
      ) : null}
      <div className="grid min-w-0 gap-1">
        <p className="truncate">
          <span className="text-muted-foreground">Started from the ad </span>
          <span className="font-medium">{adChat.headline ?? adChat.metaAdId}</span>
          {adChat.adCampaign ? (
            <>
              <span className="text-muted-foreground"> · </span>
              <Link href={`/ads/${adChat.adCampaign.id}`} className="underline">
                {adChat.adCampaign.name}
              </Link>
            </>
          ) : (
            <span className="text-muted-foreground"> · made outside the platform</span>
          )}
        </p>
        {adChat.body ? <p className="truncate text-xs text-muted-foreground">{adChat.body}</p> : null}
        <div className="flex flex-wrap items-center gap-2">
          <FreeWindowBadge window={adChat.freeWindow} />
          <span className="text-xs text-muted-foreground">{formatDateTime(adChat.startedAt)}</span>
        </div>
      </div>
    </div>
  );
}
