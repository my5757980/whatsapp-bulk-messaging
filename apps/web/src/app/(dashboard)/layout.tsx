'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@wbm/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { AssistantButton } from '@/components/ai/assistant-panel';
import { NotificationsBell } from '@/components/layout/notifications-bell';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useInboxEvents, useNewMessageSound } from '@/lib/inbox-events';
import { queryKeys } from '@/lib/query';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';

const NAV: Array<{ href: string; label: string; permission: Permission }> = [
  { href: '/inbox', label: 'Live chat', permission: 'inbox.view' },
  { href: '/campaigns', label: 'Campaigns', permission: 'campaigns.view' },
  { href: '/drips', label: 'Drips', permission: 'campaigns.view' },
  { href: '/contacts', label: 'Contacts', permission: 'contacts.view' },
  { href: '/templates', label: 'Templates', permission: 'templates.view' },
  { href: '/flows', label: 'Flows', permission: 'flows.manage' },
  { href: '/ai-agents', label: 'AI agents', permission: 'ai.manage' },
  { href: '/ai-usage', label: 'AI usage', permission: 'ai.usage' },
  { href: '/api-messages', label: 'API messages', permission: 'campaigns.view' },
  { href: '/integrations/stores', label: 'Integrations', permission: 'campaigns.view' },
  { href: '/settings/numbers', label: 'Settings', permission: 'settings.view' },
];

/** Authenticated shell with a permission-filtered sidebar (T070). */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();
  const canChat = me.data?.permissions.includes('inbox.view') ?? false;
  // One live event stream per tab, on every dashboard page (badges and sound work everywhere).
  useInboxEvents(canChat);
  useNewMessageSound(canChat);
  const unread = useQuery({
    queryKey: queryKeys.inboxUnread,
    queryFn: () => api<{ total: number }>('/inbox/unread'),
    enabled: canChat,
    refetchInterval: 60_000,
    retry: false,
  });

  async function signOut() {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    queryClient.clear();
    router.replace('/login');
  }

  if (me.isLoading) return <div className="p-8 text-muted-foreground">Loading…</div>;
  if (!me.data) return null; // 401 redirects to /login inside the API client

  const permissions = new Set(me.data.permissions);
  const items = NAV.filter((item) => permissions.has(item.permission));

  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 shrink-0 border-r bg-card p-4 md:block">
        <div className="mb-6 px-2 text-lg font-semibold">WBM</div>
        <nav className="grid gap-1">
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'rounded-md px-3 py-2 text-sm hover:bg-accent',
                pathname.startsWith(item.href.split('/').slice(0, 2).join('/')) && 'bg-accent font-medium',
              )}
            >
              <span className="flex items-center justify-between gap-2">
                {item.label}
                {item.href === '/inbox' && (unread.data?.total ?? 0) > 0 && (
                  <span
                    className="rounded-full bg-primary px-2 py-0.5 text-xs font-medium text-primary-foreground"
                    aria-label={`${unread.data!.total} unread chats`}
                  >
                    {unread.data!.total > 99 ? '99+' : unread.data!.total}
                  </span>
                )}
              </span>
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b px-6 py-3 text-sm">
          {canChat && (
            <Link href="/account/notifications" className="text-muted-foreground hover:text-foreground">
              Alerts
            </Link>
          )}
          {permissions.has('assistant.use') && <AssistantButton />}
          <NotificationsBell />
          <span className="text-muted-foreground">
            {me.data.name} · {me.data.role.toLowerCase()}
          </span>
          <Button variant="ghost" size="sm" onClick={signOut}>
            Sign out
          </Button>
        </header>
        <main className="flex-1 p-6">{children}</main>
      </div>
    </div>
  );
}
