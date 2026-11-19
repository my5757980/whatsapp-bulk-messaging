'use client';

import type { Permission } from '@wbm/shared';
import type { ReactNode } from 'react';
import { useMe } from './session';

/** Permission checks for hiding UI the server would refuse anyway (T068, ADR-0005). */
export function usePermissions() {
  const me = useMe();
  const granted = new Set<Permission>(me.data?.permissions ?? []);
  return {
    ready: me.isSuccess,
    can: (permission: Permission) => granted.has(permission),
  };
}

export function Can({ permission, children, fallback = null }: { permission: Permission; children: ReactNode; fallback?: ReactNode }) {
  const { can } = usePermissions();
  return <>{can(permission) ? children : fallback}</>;
}
