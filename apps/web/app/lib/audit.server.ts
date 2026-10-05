import { env } from "cloudflare:workers";

import { type AuditEntry, type AuditQuery, type Viewer, auditClient } from "@g1t/contracts";

import { visibilityFor } from "./audit";
import { roleIn } from "./session.server";

/** The audit log, which the events service keeps. */
export const audit = auditClient(env.EVENTS);

/** The most rows one export writes. */
export const EXPORT_LIMIT = 10_000;

/**
 * Entries of a workspace's log the viewer may see, or null when they may
 * see none of it.
 */
export async function auditPage(viewer: Viewer, query: Omit<AuditQuery, "visibility">) {
  const visibility = viewer ? visibilityFor(roleIn(viewer, query.workspace), viewer.username) : null;
  if (!visibility) return null;
  return audit.list({ ...query, workspace: query.workspace.toLowerCase(), visibility });
}

/** Every entry matching `query`, page by page, up to `EXPORT_LIMIT`. */
export async function auditAll(viewer: Viewer, query: Omit<AuditQuery, "visibility">): Promise<AuditEntry[] | null> {
  const entries: AuditEntry[] = [];
  let before = query.before ?? null;
  while (entries.length < EXPORT_LIMIT) {
    const page = await auditPage(viewer, { ...query, before, limit: 500 });
    if (!page) return null;
    entries.push(...page.entries);
    if (!page.next) break;
    before = page.next;
  }
  return entries.slice(0, EXPORT_LIMIT);
}

/**
 * What the given runs did, oldest first, for members of the workspace.
 * Not narrowed to one repository: an attempt on another is what most
 * needs to be seen.
 */
export async function runAudit(viewer: Viewer, owner: string, runIds: string[]): Promise<AuditEntry[]> {
  if (runIds.length === 0) return [];
  const page = await auditPage(viewer, {
    workspace: owner,
    runIds: runIds.slice(0, 50),
    limit: 200,
  }).catch(() => null);
  return page ? [...page.entries].reverse() : [];
}
