import { toast } from '@/components/ui/toaster';
import { ApiError } from './api-client';

/** Human-readable message for an API error, including field details when present. */
export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    const details = error.details?.map((d) => `${d.field}: ${d.issue}`).join('; ');
    return details ? `${error.message} (${details})` : error.message;
  }
  return 'Something went wrong. Please try again.';
}

export function toastError(error: unknown): void {
  toast.error(errorMessage(error));
}
