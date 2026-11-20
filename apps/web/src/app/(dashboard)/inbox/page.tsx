'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { ChatView } from '@/components/inbox/chat-view';
import { ConversationList } from '@/components/inbox/conversation-list';
import { ProfilePanel } from '@/components/inbox/profile-panel';
import { RequirePermission } from '@/components/require-permission';
import { useMe } from '@/lib/session';

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
