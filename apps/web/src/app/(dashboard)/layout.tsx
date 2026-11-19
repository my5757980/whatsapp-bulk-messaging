'use client';

import { useQueryClient } from '@tanstack/react-query';
import type { Permission } from '@wbm/shared';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { NotificationsBell } from '@/components/layout/notifications-bell';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useMe } from '@/lib/session';
import { cn } from '@/lib/utils';

const NAV: Array<{ href: string; label: string; permission: Permission }> = [
  { href: '/campaigns', label: 'Campaigns', permission: 'campaigns.view' },
  { href: '/contacts', label: 'Contacts', permission: 'contacts.view' },
  { href: '/templates', label: 'Templates', permission: 'templates.view' },
  { href: '/api-messages', label: 'API messages', permission: 'campaigns.view' },
  { href: '/settings/numbers', label: 'Settings', permission: 'settings.view' },
];

/** Authenticated shell with a permission-filtered sidebar (T070). */
export default function DashboardLayout({ children }: { children: ReactNode }) {
  const me = useMe();
  const pathname = usePathname();
  const router = useRouter();
  const queryClient = useQueryClient();

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
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-end gap-3 border-b px-6 py-3 text-sm">
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
