/**
 * The Invoices and Audit log pages' arithmetic and wording: filters read
 * from the address, totals, links from billing's account ids to sudo's
 * pages, and paging. No Workers imports, so it can be tested under Node.
 */
import type { AdminAction, InvoiceSummary } from "@g1t/contracts";

// --- Invoices -----------------------------------------------------------------

export const INVOICE_STATUSES = ["open", "overdue", "failed", "paid", "void"] as const;
export type InvoiceStatusFilter = (typeof INVOICE_STATUSES)[number];

export function parseInvoiceStatus(value: string | null): InvoiceStatusFilter | null {
  return INVOICE_STATUSES.find((status) => status === value) ?? null;
}

/** A month as `<input type="month">` sends it: `2026-10`. */
export function parseMonth(value: string | null): string | null {
  if (!value || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) return null;
  return value;
}

/** Not paid and not void: what is still owed. */
export function isOutstanding(status: string): boolean {
  return status === "open" || status === "overdue" || status === "failed";
}

export type InvoiceTotals = { count: number; amountMicros: number; paidMicros: number; outstandingMicros: number; outstanding: number };

export function invoiceTotals(invoices: Pick<InvoiceSummary, "amountMicros" | "status">[]): InvoiceTotals {
  const totals: InvoiceTotals = { count: invoices.length, amountMicros: 0, paidMicros: 0, outstandingMicros: 0, outstanding: 0 };
  for (const invoice of invoices) {
    if (invoice.status === "void") continue;
    totals.amountMicros += invoice.amountMicros;
    if (invoice.status === "paid") totals.paidMicros += invoice.amountMicros;
    if (isOutstanding(invoice.status)) {
      totals.outstandingMicros += invoice.amountMicros;
      totals.outstanding += 1;
    }
  }
  return totals;
}

/** A link to the invoices list with these filters; the defaults are left out. */
export function invoicesHref({ status, month }: { status?: string | null; month?: string | null }): string {
  const params = new URLSearchParams();
  if (status) params.set("status", status);
  if (month) params.set("month", month);
  const query = params.toString();
  return query ? `/invoices?${query}` : "/invoices";
}

/** Only https links to Stripe are followed. */
export function safeUrl(url: string | null | undefined): string | null {
  return url && url.startsWith("https://") ? url : null;
}

// --- Accounts -------------------------------------------------------------------

const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const ENTERPRISE = /^ent_[a-z0-9_-]{1,80}$/;

/**
 * The sudo page for one of billing's account ids: `ws_<slug>` is the
 * workspace's, `ent_…` the enterprise's. Null for anything else, such as
 * Stripe's own lines.
 */
export function accountPath(account: string | null | undefined): string | null {
  const id = (account ?? "").trim().toLowerCase();
  const status = /^(incident|maintenance):([a-z0-9-]{1,64})$/.exec(id);
  if (status) return status[1] === "incident" ? `/incidents/${status[2]}` : `/incidents/maintenance/${status[2]}`;
  if (ENTERPRISE.test(id)) return `/enterprises/${encodeURIComponent(id)}`;
  if (id.startsWith("ws_") && SLUG.test(id.slice(3))) return `/workspaces/${encodeURIComponent(id.slice(3))}`;
  return null;
}

/** What to call an account: a workspace by its slug, an enterprise by its name when known. */
export function accountName(account: string, names: Map<string, string> = new Map()): string {
  if (names.has(account)) return names.get(account) as string;
  if (account.startsWith("incident:")) return "Incident";
  if (account.startsWith("maintenance:")) return "Maintenance";
  if (account.startsWith("ws_")) return account.slice(3);
  if (ENTERPRISE.test(account)) return "an enterprise";
  return account;
}

// --- Audit ----------------------------------------------------------------------

/** Each kind of change, as staff read it. */
export const AUDIT_ACTIONS: Record<string, string> = {
  terms: "Terms changed",
  allowances: "Plan, pools and caps changed",
  payment: "Bank transfer recorded",
  goodwill: "Goodwill credit",
  request: "Request answered",
  create: "Enterprise created",
  attach: "Workspace added",
  detach: "Workspace removed",
  credit: "Credit issued",
  billing_link: "Billing link made",
  billing_email: "Invoice email set",
  invoice: "Invoice sent",
  dispute: "Payment disputed",
  sales: "Sales record changed",
  note: "Sales note added",
  stripe: "From Stripe",
  webhook: "Stripe webhook registered",
  // From the status page (apps/status), merged in by the Audit log page.
  incident_declared: "Incident declared",
  incident_detected: "Incident detected",
  incident_update: "Incident update",
  incident_note: "Incident note",
  incident_resolved: "Incident resolved",
  incident_roles: "Incident roles",
  incident_published: "Incident published",
  incident_dismissed: "Draft dismissed",
  incident_followup: "Incident follow-up",
  postmortem_saved: "Postmortem saved",
  postmortem_published: "Postmortem published",
  postmortem_unpublished: "Postmortem taken down",
  maintenance_scheduled: "Maintenance scheduled",
  maintenance_update: "Maintenance update",
  maintenance_started: "Maintenance started",
  maintenance_completed: "Maintenance completed",
  maintenance_cancelled: "Maintenance cancelled",
};

/**
 * The status page's audit lines as the Audit log lists billing's: the
 * account is `incident:<id>` or `maintenance:<id>`, which link to their
 * pages in sudo.
 */
export function statusAuditActions(entries: { id: string; at: string; by: string; action: string; target: string; detail: string }[]): AdminAction[] {
  return entries.map((e) => ({
    id: `status-${e.id}`,
    account: `${e.action.startsWith("maintenance_") ? "maintenance" : "incident"}:${e.target}`,
    action: e.action,
    detail: e.detail,
    by: e.by,
    createdAt: e.at,
  }));
}

/** Billing's lines and the status page's, newest first, one page's worth. */
export function mergeAudit(a: AdminAction[], b: AdminAction[], page = AUDIT_PAGE): AdminAction[] {
  return [...a, ...b].sort((x, y) => y.createdAt.localeCompare(x.createdAt)).slice(0, page);
}

export function actionLabel(action: string): string {
  return AUDIT_ACTIONS[action] ?? action.replace(/_/g, " ").replace(/^./, (char) => char.toUpperCase());
}

export const AUDIT_PAGE = 100;

/** Where the next, older page starts: after the last line, if this page was full. */
export function olderBefore(actions: Pick<AdminAction, "createdAt">[], page = AUDIT_PAGE): string | null {
  return actions.length >= page ? (actions.at(-1)?.createdAt ?? null) : null;
}

/** A staff email filter: lowercased, at most one address's length. */
export function parseBy(value: string | null): string | null {
  const by = (value ?? "").trim().toLowerCase();
  return by && by.length <= 254 && !/\s/.test(by) ? by : null;
}

export function parseAction(value: string | null): string | null {
  const action = (value ?? "").trim();
  return /^[a-z_]{1,40}$/.test(action) ? action : null;
}

/** An RFC 3339 time to page from. */
export function parseBefore(value: string | null): string | null {
  if (!value || value.length > 40 || Number.isNaN(new Date(value).getTime())) return null;
  return value;
}

export function auditHref({ by, action, before }: { by?: string | null; action?: string | null; before?: string | null }): string {
  const params = new URLSearchParams();
  if (by) params.set("by", by);
  if (action) params.set("action", action);
  if (before) params.set("before", before);
  const query = params.toString();
  return query ? `/audit?${query}` : "/audit";
}
