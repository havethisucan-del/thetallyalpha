import type { Announcement } from '../../match/cartignon/labels';
import { alertClass } from '../../components/ui';

/**
 * Live regions for action results (R8c). Both regions stay mounted so screen readers pick up
 * changes: results are announced politely (screen-reader only, the table itself shows the
 * change), rejections assertively and also visibly. Each message is keyed by its actionId, so a
 * repeated text is still a new announcement.
 */
export function ActionAnnouncer({
  announcement,
  messageKey,
}: {
  announcement: Announcement | null;
  messageKey: string | null;
}) {
  const polite = announcement?.politeness === 'polite' ? announcement.text : null;
  const assertive = announcement?.politeness === 'assertive' ? announcement.text : null;
  return (
    <>
      <div aria-live="polite" aria-atomic="true" className="sr-only" data-testid="announce-polite">
        {polite && <p key={messageKey}>{polite}</p>}
      </div>
      <div aria-live="assertive" aria-atomic="true" data-testid="announce-assertive">
        {assertive && (
          <p key={messageKey} className={alertClass} data-testid="action-rejection">
            {assertive}
          </p>
        )}
      </div>
    </>
  );
}
