'use client';

import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Badge } from '@/components/ui/badge';
import { ChatView } from '@/components/inbox/chat-view';
import { ConversationList } from '@/components/inbox/conversation-list';
import { RequirePermission } from '@/components/require-permission';
import { api } from '@/lib/api-client';
import type { ConversationDetail } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';
import { useMe } from '@/lib/session';

/** Contact details beside the chat; the full profile and journey arrive with US5. */
function ProfilePanel({ id }: { id: string }) {
  const detail = useQuery({ queryKey: queryKeys.inboxConversation(id), queryFn: () => api<ConversationDetail>(`/inbox/conversations/${id}`) });
  const chat = detail.data;
  if (!chat) return null;
  const consent = { OPTED_IN: 'Opted in', OPTED_OUT: 'Opted out', UNKNOWN: 'Unknown' }[chat.profile.consentStatus];
  return (
    <aside className="hidden min-h-0 overflow-y-auto border-l p-4 text-sm lg:block" aria-label="Contact">
      <h3 className="mb-3 font-semibold">{chat.profile.name ?? 'Contact'}</h3>
      <dl className="grid gap-2">
        <div>
          <dt className="text-xs text-muted-foreground">Phone</dt>
          <dd>{chat.profile.phone ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Consent</dt>
          <dd>{consent}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Source</dt>
          <dd>{chat.profile.leadSource ?? '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-muted-foreground">Messages</dt>
          <dd>
            {chat.templateMessageCount} template · {chat.sessionMessageCount} replies
          </dd>
        </div>
        {chat.profile.tags.length > 0 && (
          <div>
            <dt className="text-xs text-muted-foreground">Tags</dt>
            <dd className="flex flex-wrap gap-1">
              {chat.profile.tags.map((t) => (
                <Badge key={t.id} variant="outline">
                  {t.name}
                </Badge>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </aside>
  );
}

function Inbox() {
  const me = useMe();
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const selected = params.get('c');
  const select = (id: string) => router.replace(`${pathname}?c=${id}`);

  if (!me.data) return null;
  const canMonitor = me.data.permissions.includes('inbox.monitor');
  return (
    <div className="-m-6 grid h-[calc(100vh-57px)] min-h-0 grid-cols-1 md:grid-cols-[320px_1fr] lg:grid-cols-[320px_1fr_280px]">
      <div className={selected ? 'hidden min-h-0 border-r md:block' : 'min-h-0 border-r'}>
        <ConversationList selectedId={selected} onSelect={select} />
      </div>
      <div className={selected ? 'min-h-0' : 'hidden min-h-0 md:block'}>
        {selected ? (
          <ChatView key={selected} id={selected} meId={me.data.id} canMonitor={canMonitor} />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">Choose a chat to start.</div>
        )}
      </div>
      {selected && <ProfilePanel id={selected} />}
    </div>
  );
}

/** Live chat (US1): Open, Waiting for agent, Taken and Past chats, with live updates. */
export default function InboxPage() {
  return (
    <RequirePermission permission="inbox.view">
      <Suspense>
        <Inbox />
      </Suspense>
    </RequirePermission>
  );
}
