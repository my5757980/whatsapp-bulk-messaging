'use client';

import type { Permission } from '@wbm/shared';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { usePermissions } from '@/lib/permissions';
import { cn } from '@/lib/utils';

const TABS: Array<{ href: string; label: string; permission: Permission }> = [
  { href: '/settings/numbers', label: 'WhatsApp numbers', permission: 'numbers.view' },
  { href: '/settings/attributes', label: 'Attributes & tags', permission: 'contacts.view' },
  // Feature 010: tags added automatically.
  { href: '/settings/automatic-tags', label: 'Automatic tags', permission: 'settings.view' },
  { href: '/settings/global-attributes', label: 'Global attributes', permission: 'contacts.view' },
  { href: '/settings/keywords', label: 'Consent keywords', permission: 'settings.view' },
  { href: '/settings/rate-card', label: 'Rate card', permission: 'campaigns.view' },
  { href: '/settings/team', label: 'Team', permission: 'users.manage' },
  { href: '/settings/security', label: 'Security', permission: 'users.manage' },
  { href: '/settings/live-chat', label: 'Live chat', permission: 'livechat.settings' },
  { href: '/settings/saved-replies', label: 'Saved replies', permission: 'inbox.view' },
  { href: '/settings/media-library', label: 'Media library', permission: 'inbox.view' },
  { href: '/settings/api-keys', label: 'API keys', permission: 'apikeys.manage' },
  { href: '/settings/one-time-codes', label: 'One-time codes', permission: 'settings.view' },
  { href: '/settings/webhooks', label: 'Webhooks', permission: 'integrations.manage' },
  { href: '/settings/audit', label: 'Audit log', permission: 'audit.view' },
];

/** Settings sub-navigation (T130). */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const { can } = usePermissions();
  return (
    <div className="grid gap-6">
      <nav className="flex flex-wrap gap-1 border-b" aria-label="Settings">
        {TABS.filter((t) => can(t.permission)).map((t) => (
          <Link
            key={t.href}
            href={t.href}
            className={cn('-mb-px border-b-2 px-3 py-2 text-sm', pathname.startsWith(t.href) ? 'border-primary font-medium' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {children}
    </div>
  );
}
