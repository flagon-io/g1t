/**
 * sudo is organised around workspaces, as customers know them. Identity
 * says which workspaces exist and who owns them; billing says who pays for
 * each and where it stands. This joins the two, by slug. No Workers
 * imports, so it can be tested under Node.
 *
 * Billing's account ids (`ws_<slug>`, `ent_…`) are internal: they are used
 * to look things up and never shown as a name.
 */
import type { AccountSummary, AdminOwner, AdminWorkspace, Limit, Terms } from "@g1t/contracts";

/** Terms every workspace starts on. */
export const STANDARD_TERMS: Terms = {
  kind: "standard",
  discountPercent: 0,
  ceilingMicros: null,
  note: "",
  until: null,
  setBy: null,
  setAt: null,
};

export type Enterprise = { id: string; name: string };

/** Where a workspace stands with billing. */
export type WorkspaceBilling = {
  /** The enterprise that pays for it, or null when it pays for itself. */
  billedTo: Enterprise | null;
  /** The terms it is charged on: its own, or its enterprise's. */
  terms: Terms;
  /**
   * Its limit this month: its own, or for a workspace on an enterprise the
   * enterprise's, which all its workspaces share. Null with no billing
   * activity yet.
   */
  limit: Limit | null;
  /** This workspace's own figures this month (charged, cost) and ever (paid). */
  chargedMicros: number;
  costMicros: number;
  paidMicros: number;
};

export type WorkspaceRow = {
  slug: string;
  name: string;
  /** Null for a workspace billing knows and identity returned nothing for. */
  createdAt: string | null;
  owners: AdminOwner[];
  memberCount: number | null;
  /** False when only billing knows the slug. */
  known: boolean;
  billing: WorkspaceBilling;
};

/** The billing side of every workspace billing knows, by slug. */
export function billingBySlug(accounts: AccountSummary[]): Map<string, WorkspaceBilling> {
  const bySlug = new Map<string, WorkspaceBilling>();
  for (const summary of accounts) {
    const { account } = summary;
    const shares = new Map((summary.byWorkspace ?? []).map((share) => [share.workspace, share]));
    if (account.kind === "enterprise") {
      for (const slug of account.workspaces) {
        const share = shares.get(slug);
        bySlug.set(slug, {
          billedTo: { id: account.id, name: account.name },
          terms: account.terms,
          limit: summary.limit,
          chargedMicros: share?.chargedMicros ?? 0,
          costMicros: share?.costMicros ?? 0,
          paidMicros: share?.paidMicros ?? 0,
        });
      }
    } else {
      const slug = account.workspaces[0] ?? summary.limit.workspace;
      // An enterprise's claim on a workspace wins over a stale own account.
      if (bySlug.get(slug)?.billedTo) continue;
      bySlug.set(slug, {
        billedTo: null,
        terms: account.terms,
        limit: summary.limit,
        chargedMicros: summary.chargedMicros,
        costMicros: summary.costMicros,
        paidMicros: summary.paidMicros,
      });
    }
  }
  return bySlug;
}

/** A workspace with no billing activity: standard terms, nothing charged. */
export function noBilling(): WorkspaceBilling {
  return { billedTo: null, terms: STANDARD_TERMS, limit: null, chargedMicros: 0, costMicros: 0, paidMicros: 0 };
}

/**
 * Every workspace identity listed, in its order, with its billing; then any
 * workspace only billing knows. A workspace with no billing activity is
 * still listed, on standard terms at $0.
 */
export function joinWorkspaces(workspaces: AdminWorkspace[], accounts: AccountSummary[]): WorkspaceRow[] {
  const billing = billingBySlug(accounts);
  const rows: WorkspaceRow[] = workspaces.map((workspace) => ({
    slug: workspace.slug,
    name: workspace.name,
    createdAt: workspace.createdAt,
    owners: workspace.owners,
    memberCount: workspace.memberCount,
    known: true,
    billing: billing.get(workspace.slug) ?? noBilling(),
  }));
  const listed = new Set(rows.map((row) => row.slug));
  for (const [slug, entry] of billing) {
    if (listed.has(slug)) continue;
    rows.push({ slug, name: slug, createdAt: null, owners: [], memberCount: null, known: false, billing: entry });
  }
  return rows;
}

/** Whether a row matches a search: slug, name, owner, owner's email or enterprise. */
export function matchesQuery(row: WorkspaceRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack = [
    row.slug,
    row.name,
    row.billing.billedTo?.name,
    ...row.owners.flatMap((owner) => [owner.username, owner.email]),
  ];
  return haystack.some((value) => value?.toLowerCase().includes(q));
}

/**
 * Where an old `/accounts/<id>` link now lives: a workspace's own account
 * (`ws_<slug>`, or a bare slug) at its workspace, an enterprise at its own
 * page. Null for anything else.
 */
export function legacyAccountPath(id: string): string | null {
  const value = id.trim().toLowerCase();
  if (/^ent_[a-z0-9_-]{1,80}$/.test(value)) return `/enterprises/${encodeURIComponent(value)}`;
  const slug = value.startsWith("ws_") ? value.slice(3) : value;
  if (/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(slug)) return `/workspaces/${encodeURIComponent(slug)}`;
  return null;
}

/** A row's owners' usernames, as one line. */
export function ownerNames(owners: AdminOwner[]): string {
  return owners.map((owner) => owner.username).join(", ");
}
