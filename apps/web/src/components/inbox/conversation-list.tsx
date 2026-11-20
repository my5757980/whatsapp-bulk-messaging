'use client';

import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { api } from '@/lib/api-client';
import { Can } from '@/lib/permissions';
import type { ConversationList, ConversationState } from '@/lib/inbox-types';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';

type Tab = ConversationState | 'HISTORY';

const TABS: Array<{ tab: Tab; label: string }> = [
  { tab: 'ACTIVE', label: 'Open' },
  { tab: 'REQUESTING', label: 'Waiting for agent' },
  { tab: 'INTERVENED', label: 'Taken' },
  { tab: 'HISTORY', label: 'Past chats' },
];

function when(value: string): string {
  const date = new Date(value);
  const sameDay = date.toDateString() === new Date().toDateString();
  return new Intl.DateTimeFormat(undefined, sameDay ? { hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short' }).format(date);
}

/** Chat list with the live tabs, Past chats and search (T035). */
export function ConversationList({ selectedId, onSelect }: { selectedId: string | null; onSelect: (id: string) => void }) {
  const [tab, setTab] = useState<Tab>('ACTIVE');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [numberId, setNumberId] = useState('');
  const [tagId, setTagId] = useState('');
  const [mine, setMine] = useState(false);
  const numbers = useQuery({ queryKey: ['inbox', 'numbers'], queryFn: () => api<Array<{ id: string; label: string }>>('/inbox/numbers') });
  const tags = useQuery({ queryKey: ['tags'], queryFn: () => api<Array<{ id: string; name: string }>>('/tags') });
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(search.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [search]);

  const filters: Record<string, string> = {
    ...(tab === 'HISTORY' ? { view: 'history' } : { view: 'live', state: tab }),
    ...(q ? { q } : {}),
    ...(numberId ? { numberId } : {}),
    ...(tagId ? { tagId } : {}),
    ...(mine ? { mine: 'true' } : {}),
  };
  const list = useInfiniteQuery({
    queryKey: queryKeys.inboxConversations(filters),
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ ...filters, limit: '30' });
      if (pageParam) params.set('cursor', pageParam);
      return api<ConversationList>(`/inbox/conversations?${params.toString()}`);
    },
    initialPageParam: '' as string,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const counts = list.data?.pages[0]?.counts;
  const chats = list.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="grid gap-2 border-b p-3">
        <Can permission="inbox.metrics">
          <Link href="/inbox/team" className="justify-self-end text-xs text-muted-foreground hover:text-foreground">
            Team view →
          </Link>
        </Can>
        <div className="grid grid-cols-2 gap-1" role="tablist" aria-label="Chat lists">
          {TABS.map((t) => (
            <button
              key={t.tab}
              role="tab"
              aria-selected={tab === t.tab}
              onClick={() => setTab(t.tab)}
              className={cn('rounded-md px-2 py-1.5 text-left text-xs hover:bg-accent', tab === t.tab && 'bg-accent font-medium')}
            >
              {t.label}
              {counts && <span className="ml-1 text-muted-foreground">({counts[t.tab]})</span>}
            </button>
          ))}
        </div>
        <Input placeholder="Search name or number" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search chats" />
        <div className="grid grid-cols-2 gap-2">
          {(numbers.data?.length ?? 0) > 1 && (
            <NativeSelect aria-label="Filter by number" value={numberId} onChange={(e) => setNumberId(e.target.value)}>
              <option value="">All numbers</option>
              {numbers.data?.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.label}
                </option>
              ))}
            </NativeSelect>
          )}
          <NativeSelect aria-label="Filter by tag" value={tagId} onChange={(e) => setTagId(e.target.value)}>
            <option value="">All tags</option>
            {tags.data?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </NativeSelect>
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={mine} onChange={(e) => setMine(e.target.checked)} />
            Only my chats
          </label>
        </div>
      </div>
      <ul className="min-h-0 flex-1 overflow-y-auto" data-testid="conversation-list">
        {list.isLoading && <li className="p-4 text-sm text-muted-foreground">Loading…</li>}
        {!list.isLoading && chats.length === 0 && <li className="p-4 text-sm text-muted-foreground">No chats here.</li>}
        {chats.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => onSelect(c.id)}
              className={cn('grid w-full gap-0.5 border-b px-3 py-2 text-left hover:bg-accent', selectedId === c.id && 'bg-accent')}
              data-testid="conversation-row"
            >
              <span className="flex items-center justify-between gap-2">
                <span className={cn('truncate text-sm', c.unread > 0 && 'font-semibold')}>{c.contactName ?? c.phone ?? 'Unknown contact'}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{when(c.lastActivityAt)}</span>
              </span>
              <span className="flex items-center justify-between gap-2">
                <span className="truncate text-xs text-muted-foreground">{c.lastMessagePreview ?? ' '}</span>
                {c.unread > 0 && (
                  <Badge className="shrink-0" aria-label={`${c.unread} unread`}>
                    {c.unread >= 99 ? '99+' : c.unread}
                  </Badge>
                )}
              </span>
              {(c.state === 'INTERVENED' && c.intervenedBy) || c.blocked ? (
                <span className="text-[11px] text-muted-foreground">
                  {c.blocked ? 'Blocked' : `Taken by ${c.intervenedBy?.name}`}
                </span>
              ) : null}
            </button>
          </li>
        ))}
        {list.hasNextPage && (
          <li className="p-2 text-center">
            <Button variant="ghost" size="sm" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
              {list.isFetchingNextPage ? 'Loading…' : 'Load more'}
            </Button>
          </li>
        )}
      </ul>
    </div>
  );
}
