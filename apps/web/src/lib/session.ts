'use client';

import { useQuery } from '@tanstack/react-query';
import type { Permission, Role } from '@wbm/shared';
import { api } from './api-client';
import { queryKeys } from './query';

export interface Me {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
  lastLoginAt: string | null;
  permissions: Permission[];
}

/** Current user from GET /auth/me. */
export function useMe() {
  return useQuery({ queryKey: queryKeys.me, queryFn: () => api<Me>('/auth/me'), staleTime: 60_000 });
}
