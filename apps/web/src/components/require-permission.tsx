'use client';

import type { Permission } from '@wbm/shared';
import type { ReactNode } from 'react';
import { usePermissions } from '@/lib/permissions';

/** Page-level gate (T180): the server enforces permissions; this avoids showing dead-end pages. */
export function RequirePermission({ permission, children }: { permission: Permission; children: ReactNode }) {
  const { ready, can } = usePermissions();
  if (!ready) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!can(permission)) {
    return (
      <div role="alert" className="rounded-md border p-6 text-sm text-muted-foreground">
        Your role does not have access to this page. Ask an admin if you need it.
      </div>
    );
  }
  return <>{children}</>;
}
