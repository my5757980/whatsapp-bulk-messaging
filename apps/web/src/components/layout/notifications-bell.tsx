'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { api } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';

interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

const POLL_MS = 30_000;

/** Notifications bell (T152, FR-038): unread count, latest items, mark read and deep links. */
export function NotificationsBell() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const notifications = useQuery({
    queryKey: queryKeys.notifications,
    queryFn: () => api<AppNotification[]>('/notifications'),
    refetchInterval: POLL_MS,
  });
  const items = notifications.data ?? [];
  const unread = items.filter((n) => !n.readAt).length;

  async function open(n: AppNotification) {
    if (!n.readAt) await api(`/notifications/${n.id}/read`, { method: 'POST' }).catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
    if (n.link) router.push(n.link);
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
          <Bell className="h-4 w-4" />
          {unread ? (
            <span
              className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-destructive px-1 text-center text-[10px] font-semibold leading-4 text-destructive-foreground"
              data-testid="unread-count"
            >
              {unread > 9 ? '9+' : unread}
            </span>
          ) : null}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-80">
        <DropdownMenuLabel>Notifications</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {!items.length ? <p className="px-2 py-3 text-sm text-muted-foreground">No notifications yet.</p> : null}
        {items.slice(0, 15).map((n) => (
          <DropdownMenuItem key={n.id} onSelect={() => void open(n)} className="flex flex-col items-start gap-0.5">
            <div className="flex w-full items-center gap-2">
              <span className={cn('text-sm', !n.readAt && 'font-semibold')}>{n.title}</span>
              {!n.readAt ? <span className="ml-auto h-2 w-2 shrink-0 rounded-full bg-primary" aria-label="unread" /> : null}
            </div>
            <span className="text-xs text-muted-foreground">{n.body}</span>
            <span className="text-[10px] text-muted-foreground">{formatDateTime(n.createdAt)}</span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
