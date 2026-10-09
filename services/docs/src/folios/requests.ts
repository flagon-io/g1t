/**
 * Access requests' limit: a person asks for a folio at most once a day,
 * however many times they press the button. One row per person and folio
 * (`folio_access_requests`) holds when they last asked.
 */

/** How long a person waits before asking for the same folio again. */
export const REQUEST_EVERY_MS = 24 * 60 * 60 * 1000;
/** The most people one request goes to: the owner and people with full access. */
export const REQUEST_RECIPIENTS = 20;

/**
 * Records a request when the person may ask now, in one statement so two
 * presses at once send one request. True: send it. False: they asked for
 * this folio within the last day.
 */
export async function claimAccessRequest(db: D1Database, folioId: string, userId: string, at = new Date()): Promise<boolean> {
  const when = at.toISOString();
  const since = new Date(at.getTime() - REQUEST_EVERY_MS).toISOString();
  const row = await db
    .prepare(
      `INSERT INTO folio_access_requests (folio_id, user_id, requested_at) VALUES (?, ?, ?)
       ON CONFLICT (folio_id, user_id) DO UPDATE SET requested_at = excluded.requested_at WHERE folio_access_requests.requested_at <= ?
       RETURNING requested_at`,
    )
    .bind(folioId, userId, when, since)
    .first<{ requested_at: string }>();
  return row !== null;
}
