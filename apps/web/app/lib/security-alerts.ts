/**
 * The Security page's alerts, sorted and described: which filter an alert
 * falls under, which secrets are likely test values, packages grouped with
 * their worst severity, what each security update state means, and each
 * alert's activity as a list of entries. Pure, so it is tested on its own.
 */
import type {
  AlertActivity,
  AlertState,
  DismissReason,
  SecretFinding,
  SecurityUpdate,
  Severity,
  UpdateState,
  Vulnerability,
} from "@g1t/contracts";

/** Most severe first, as the contracts list them; here so the tests need no build of the contracts. */
const SEVERITIES: Severity[] = ["critical", "high", "medium", "low", "unknown"];

export const ALERT_STATES: AlertState[] = ["open", "dismissed", "fixed"];

/** The `state` URL parameter as a filter; anything else is `open`. */
export function parseAlertState(value: string | null | undefined): AlertState {
  return value === "dismissed" || value === "fixed" ? value : "open";
}

/** Which tab an alert's id belongs on. */
export function tabOf(id: string): "secrets" | "dependencies" {
  return id.startsWith("vul_") ? "dependencies" : "secrets";
}

/**
 * The role an alert takes to dismiss or reopen: Admin
 * (`manage_integrations`) for a secret, Write (`push`) for a dependency.
 */
export function alertCapability(id: string): "manage_integrations" | "push" {
  return id.startsWith("vul_") ? "push" : "manage_integrations";
}

export function countByState(alerts: { state: AlertState }[]): Record<AlertState, number> {
  const counts: Record<AlertState, number> = { open: 0, dismissed: 0, fixed: 0 };
  for (const alert of alerts) counts[alert.state] += 1;
  return counts;
}

/** Open secrets that look real first, then the likely test values. */
export function splitSecrets(secrets: SecretFinding[]): { real: SecretFinding[]; tests: SecretFinding[] } {
  return {
    real: secrets.filter((secret) => !secret.testValue),
    tests: secrets.filter((secret) => !!secret.testValue),
  };
}

export type PackageGroup = { key: string; ecosystem: string; name: string; vulns: Vulnerability[] };

/** Alerts grouped by package, in the order they first appear. */
export function groupByPackage(vulnerabilities: Vulnerability[]): PackageGroup[] {
  const map = new Map<string, PackageGroup>();
  for (const vuln of vulnerabilities) {
    const key = `${vuln.ecosystem}:${vuln.package}`;
    const group = map.get(key) ?? { key, ecosystem: vuln.ecosystem, name: vuln.package, vulns: [] };
    group.vulns.push(vuln);
    map.set(key, group);
  }
  return [...map.values()];
}

export function worstSeverity(vulns: { severity: Severity }[]): Severity {
  return SEVERITIES.find((severity) => vulns.some((vuln) => vuln.severity === severity)) ?? "unknown";
}

/** The package's newest security update, if g1t has started one. */
export function latestUpdate(vulns: Vulnerability[]): SecurityUpdate | null {
  let latest: SecurityUpdate | null = null;
  for (const vuln of vulns) {
    if (vuln.update && (!latest || vuln.update.updatedAt > latest.updatedAt)) latest = vuln.update;
  }
  return latest;
}

/** The highest fixed version among `vulns`, compared number by number. */
export function highestFix(vulns: Vulnerability[]): string | null {
  const versions = vulns.map((vuln) => vuln.fixedVersion).filter((version): version is string => !!version);
  if (versions.length === 0) return null;
  return versions.sort(compareVersions).at(-1)!;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/);
  const pb = b.split(/[.+-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? "";
    const y = pb[i] ?? "";
    const nx = Number(x);
    const ny = Number(y);
    const order = x !== "" && y !== "" && !Number.isNaN(nx) && !Number.isNaN(ny) ? nx - ny : x.localeCompare(y);
    if (order !== 0) return order;
  }
  return 0;
}

/** A security update's state as the page names it, and what it means. */
export const UPDATE_STATES: Record<UpdateState, { label: string; tone: "accent" | "info" | "merged" | "neutral" | "warn" | "danger" }> = {
  requested: { label: "Security update in progress", tone: "info" },
  open: { label: "Security update open", tone: "accent" },
  merged: { label: "Security update merged", tone: "merged" },
  closed: { label: "Security update closed", tone: "neutral" },
  superseded: { label: "Security update superseded", tone: "neutral" },
  needs_code: { label: "Needs code changes", tone: "warn" },
  failed: { label: "Security update failed", tone: "danger" },
};

/** One line of an alert's activity log. */
export type ActivityEntry = {
  key: string;
  /** A username, `g1t`, or null when nobody in particular. */
  actor: string | null;
  /** What happened, after the actor's name. */
  text: string;
  /** The pull request or issue it concerns. */
  ref: { kind: "pull" | "issue"; number: number } | null;
  reason: DismissReason | null;
  comment: string | null;
  at: string;
};

function describe(row: AlertActivity): { text: string; ref: ActivityEntry["ref"] } {
  const pull = row.number != null ? { kind: "pull" as const, number: row.number } : null;
  switch (row.action) {
    case "dismissed":
      return { text: "dismissed it", ref: null };
    case "reopened":
      return { text: "reopened it", ref: null };
    case "update_requested":
      return { text: "started a security update", ref: null };
    case "update_opened":
      return { text: "opened a security update", ref: pull };
    case "update_merged":
      return { text: "merged the security update", ref: pull };
    case "update_closed":
      return { text: "closed the security update", ref: pull };
    case "update_superseded":
      return { text: "closed the security update as superseded", ref: pull };
    case "update_needs_code":
      return {
        text: "found the upgrade needs code changes and opened an issue for g1t-agent",
        ref: row.number != null ? { kind: "issue", number: row.number } : null,
      };
    case "update_failed":
      return { text: "could not make the security update", ref: null };
    default:
      return { text: row.action.replace(/_/g, " "), ref: pull };
  }
}

/**
 * Everything that happened to an alert, oldest first: the rows recorded
 * for it, with when it was found, and older decisions made before rows
 * were kept.
 */
export function alertActivity(alert: SecretFinding | Vulnerability, activity: AlertActivity[]): ActivityEntry[] {
  const rows = activity.filter((row) => row.alertId === alert.id);
  const entries: ActivityEntry[] = rows.map((row) => ({
    key: row.id,
    actor: row.actor,
    ...describe(row),
    reason: row.reason,
    comment: row.comment,
    at: row.at,
  }));
  const dismissedRow = rows.some((row) => row.action === "dismissed");
  if ("kind" in alert) {
    entries.push({
      key: `${alert.id}:found`,
      actor: alert.source === "push" ? alert.foundBy : null,
      text: alert.source === "push" ? (alert.status === "blocked" ? "pushed it, and the push was refused" : "pushed it") : "Found in the history",
      ref: null,
      reason: null,
      comment: null,
      at: alert.foundAt,
    });
    if (alert.decidedBy && alert.decidedAt && !dismissedRow && alert.state !== "open") {
      entries.push({
        key: `${alert.id}:decided`,
        actor: alert.decidedBy,
        text: alert.state === "fixed" && !alert.dismissedReason ? "marked it resolved" : "dismissed it",
        ref: null,
        reason: alert.dismissedReason ?? (alert.state === "fixed" ? null : alert.status === "allowed" ? "false_positive" : null),
        comment: alert.reason,
        at: alert.decidedAt,
      });
    }
  } else {
    entries.push({
      key: `${alert.id}:found`,
      actor: null,
      text: `Found ${alert.package} ${alert.version} in ${alert.manifest}`,
      ref: null,
      reason: null,
      comment: null,
      at: alert.foundAt,
    });
    if (alert.dismissedBy && alert.dismissedAt && !dismissedRow && alert.state === "dismissed") {
      entries.push({
        key: `${alert.id}:dismissed`,
        actor: alert.dismissedBy,
        text: "dismissed it",
        ref: null,
        reason: alert.dismissedReason ?? null,
        comment: alert.dismissedComment ?? null,
        at: alert.dismissedAt,
      });
    }
    if (alert.state === "fixed" && alert.fixedAt && !rows.some((row) => row.action === "update_merged")) {
      entries.push({
        key: `${alert.id}:fixed`,
        actor: "g1t",
        text: "found it no longer vulnerable",
        ref: null,
        reason: null,
        comment: null,
        at: alert.fixedAt,
      });
    }
  }
  return entries.sort((a, b) => a.at.localeCompare(b.at));
}
