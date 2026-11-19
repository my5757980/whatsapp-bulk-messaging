'use client';

import { Toaster as SonnerToaster, toast } from 'sonner';

export function Toaster() {
  return <SonnerToaster richColors position="top-right" closeButton />;
}

export { toast };
