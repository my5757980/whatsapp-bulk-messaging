import { formatNumber } from '@/lib/format';

/**
 * Meta's per-person limit on marketing messages (feature 009 US7, FR-029): shown when a marketing
 * template is chosen, and in the results with how many messages it held back.
 */
export function FrequencyCapNote({ heldBack }: { heldBack?: number }) {
  return (
    <div role="note" className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100" data-testid="frequency-cap-note">
      Meta limits how many marketing messages each person receives from all businesses, so some people may not get this message.
      {heldBack !== undefined ? (
        <>
          {' '}
          <span className="font-medium">{formatNumber(heldBack)} held back</span> by this limit; they are not charged and retry rounds do not resend them within 24 hours.
        </>
      ) : (
        ' Those messages are counted as held back and are not charged.'
      )}
    </div>
  );
}
