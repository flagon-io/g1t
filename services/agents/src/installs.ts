/**
 * The Marketplace's install requests (docs.g1t.sh/guides/marketplace/): a
 * member asks the workspace's owners to add an extension or an
 * integration, and an owner adds it or turns it down. Kept in
 * `install_requests`, one open request per person and listing.
 *
 * Only what can be added today can be asked for: a published extension,
 * or a connector the catalog marks available for a workspace
 * (@g1t/contracts/connectors). Agents aren't asked for here: they start
 * from templates in Agents mode, and owners make them. Who is told, and
 * how, is index.ts's; this file is the rules and the table, tested on
 * SQLite.
 */
import type { FailureCode, InstallRequest, InstallRequestStatus, ListingKind, Result } from "@g1t/contracts";
import { CONNECTORS } from "@g1t/contracts/connectors";
import { ANSWERED_REQUESTS_DAYS, MAX_OPEN_REQUESTS, extensionById, listingRef, parseListing } from "@g1t/contracts/marketplace";

// Plain values rather than @g1t/contracts' helpers, so this file runs under Node's tests.
const ok = <T>(value: T): Result<T> => ({ ok: true, value });
const fail = (code: FailureCode, message: string): Result<never> => ({ ok: false, error: { code, message } });

/** Something the workspace can add, as a request names it. */
export type Listing = { ref: string; kind: ListingKind; id: string; name: string };

/** The listing `value` names, when it is one that can be added today; null otherwise. */
export function findListing(value: unknown): Listing | null {
  const parsed = parseListing(value);
  if (!parsed) return null;
  if (parsed.kind === "extension") {
    const extension = extensionById(parsed.id);
    return extension?.status === "available" ? { ref: listingRef("extension", extension.id), kind: "extension", id: extension.id, name: extension.name } : null;
  }
  const connector = CONNECTORS.find((c) => c.id === parsed.id);
  if (!connector || connector.status !== "available" || !connector.scopes.includes("workspace")) return null;
  return { ref: listingRef("integration", connector.id), kind: "integration", id: connector.id, name: connector.name };
}

type Row = {
  id: string;
  listing: string;
  name: string;
  note: string | null;
  requested_by: string;
  requested_by_id: string;
  requested_at: string;
  status: string;
  resolved_by: string | null;
  resolved_at: string | null;
};

const COLUMNS = "id, listing, name, note, requested_by, requested_by_id, requested_at, status, resolved_by, resolved_at";

/** A row as a request; null for one whose listing is no longer a kind the Marketplace has. */
export function toRequest(row: Row): InstallRequest | null {
  const parsed = parseListing(row.listing);
  if (!parsed) return null;
  return {
    id: row.id,
    listing: row.listing,
    kind: parsed.kind,
    name: row.name,
    note: row.note,
    requested_by: row.requested_by,
    requested_at: row.requested_at,
    status: (["open", "done", "declined"].includes(row.status) ? row.status : "open") as InstallRequestStatus,
    resolved_by: row.resolved_by,
    resolved_at: row.resolved_at,
  };
}

/** Who is asking or answering. */
export type Person = { id: string; username: string };

/**
 * Requests as `viewer` sees them: every one in the workspace for an owner,
 * their own for anyone else. Open ones first, then the latest; answered
 * ones for `ANSWERED_REQUESTS_DAYS`. At most 200.
 */
export async function listRequests(db: D1Database, workspaceId: string, viewer: Person, owner: boolean, now = new Date()): Promise<InstallRequest[]> {
  const since = new Date(now.getTime() - ANSWERED_REQUESTS_DAYS * 86_400_000).toISOString();
  const mine = owner ? "" : " AND requested_by_id = ?3";
  const statement = db.prepare(
    `SELECT ${COLUMNS} FROM install_requests
     WHERE workspace_id = ?1 AND (status = 'open' OR resolved_at >= ?2)${mine}
     ORDER BY status = 'open' DESC, requested_at DESC LIMIT 200`,
  );
  const bound = owner ? statement.bind(workspaceId, since) : statement.bind(workspaceId, since, viewer.id);
  const { results } = await bound.all<Row>();
  return results.map(toRequest).filter((request) => request !== null);
}

/**
 * Opens a request for `listing`, as `id`. A conflict when the person has
 * one open for it already; a limit when they have `MAX_OPEN_REQUESTS` open.
 */
export async function openRequest(
  db: D1Database,
  workspaceId: string,
  id: string,
  listing: Listing,
  by: Person,
  note: string | null,
  now = new Date(),
): Promise<Result<InstallRequest>> {
  const open = await db
    .prepare("SELECT COUNT(*) AS n FROM install_requests WHERE workspace_id = ? AND requested_by_id = ? AND status = 'open'")
    .bind(workspaceId, by.id)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_REQUESTS) {
    return fail("limit", `You have ${MAX_OPEN_REQUESTS} requests waiting on an owner. Ask again once some are answered.`);
  }
  const row: Row = {
    id,
    listing: listing.ref,
    name: listing.name,
    note,
    requested_by: by.username,
    requested_by_id: by.id,
    requested_at: now.toISOString(),
    status: "open",
    resolved_by: null,
    resolved_at: null,
  };
  // The unique index on open requests turns a second press into nothing.
  const inserted = await db
    .prepare(
      `INSERT INTO install_requests (id, workspace_id, listing, name, note, requested_by, requested_by_id, requested_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open') ON CONFLICT DO NOTHING RETURNING id`,
    )
    .bind(row.id, workspaceId, row.listing, row.name, row.note, row.requested_by, row.requested_by_id, row.requested_at)
    .first<{ id: string }>();
  if (!inserted) return fail("conflict", `You've already asked for ${listing.name}. The workspace's owners have your request.`);
  return ok(toRequest(row)!);
}

/** A request answered, with who asked, for telling them. */
export type Answered = { request: InstallRequest; requested_by_id: string };

/** An owner adds (`done`) or turns down (`declined`) an open request. */
export async function resolveRequest(
  db: D1Database,
  workspaceId: string,
  id: string,
  status: Exclude<InstallRequestStatus, "open">,
  by: Person,
  now = new Date(),
): Promise<Result<Answered>> {
  if (status !== "done" && status !== "declined") return fail("invalid", "Answer a request with done or declined.");
  const row = await db
    .prepare(
      `UPDATE install_requests SET status = ?, resolved_by = ?, resolved_at = ?
       WHERE id = ? AND workspace_id = ? AND status = 'open' RETURNING ${COLUMNS}`,
    )
    .bind(status, by.username, now.toISOString(), id, workspaceId)
    .first<Row>();
  const request = row ? toRequest(row) : null;
  if (row && request) return ok({ request, requested_by_id: row.requested_by_id });
  const exists = await db.prepare("SELECT status FROM install_requests WHERE id = ? AND workspace_id = ?").bind(id, workspaceId).first<{ status: string }>();
  return exists ? fail("conflict", "That request was already answered.") : fail("not_found", "There is no such request.");
}

/**
 * Every open request for `listing`, marked added: an owner added it, so
 * whoever asked for it has what they asked for.
 */
export async function resolveListing(db: D1Database, workspaceId: string, listing: string, by: Person, now = new Date()): Promise<Answered[]> {
  const { results } = await db
    .prepare(
      `UPDATE install_requests SET status = 'done', resolved_by = ?, resolved_at = ?
       WHERE workspace_id = ? AND listing = ? AND status = 'open' RETURNING ${COLUMNS}`,
    )
    .bind(by.username, now.toISOString(), workspaceId, listing)
    .all<Row>();
  return results.flatMap((row) => {
    const request = toRequest(row);
    return request ? [{ request, requested_by_id: row.requested_by_id }] : [];
  });
}

/** Where a request is looked at in the workspace `slug`. */
export function requestsPath(slug: string): string {
  return `/${slug}/-/marketplace/requests`;
}

/** Where the thing a request asked for is, once added. */
export function listingPath(slug: string, listing: string): string {
  const parsed = parseListing(listing);
  if (parsed?.kind === "extension") return `/${slug}/-/marketplace/extensions/${parsed.id}`;
  return `/${slug}/-/marketplace/integrations`;
}

/** What the person who asked is told when their request is answered. */
export function answerLine(request: InstallRequest, by: string): { title: string; body: string } {
  if (request.status === "declined") {
    return { title: `${by} turned down your request for ${request.name}`, body: "Ask them in chat if you want to know why." };
  }
  return {
    title: `${request.name} was added to the workspace`,
    body: request.kind === "extension" ? `${by} installed it.` : `${by} connected it.`,
  };
}
