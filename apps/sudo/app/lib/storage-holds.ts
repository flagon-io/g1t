/**
 * The Storage holds page's words and forms: public storage reservations
 * and copy locks that outlived their write (the repos service's
 * storage_holds.rs decides what is provably abandoned; this only says it).
 * No Workers imports, so it can be tested under Node.
 */
import type { AdminLogEntry, BillingAdminApi, ReposAdminApi, StorageHoldKind, StorageRecovery } from "@g1t/contracts";

import type { Parsed } from "./forms.ts";
import { settle } from "./settle.ts";

export const HOLD_KINDS: StorageHoldKind[] = ["reservation", "unledgered", "copy_lock"];

/** The longest reason, as kept in the audit row. */
export const MAX_REASON = 500;

const KIND_LABEL: Record<StorageHoldKind, string> = {
  reservation: "Reservation",
  unledgered: "Unledgered",
  copy_lock: "Copy lock",
};

export function kindLabel(kind: StorageHoldKind): string {
  return KIND_LABEL[kind] ?? kind;
}

const OPERATION_LABEL: Record<string, string> = {
  push: "a push over git",
  commit: "a commit from the web",
  merge: "a pull request merge",
  queue: "the merge queue",
  update: "a pull request brought up to date",
  land: "a branch landed",
  sync: "a fork synced",
  import: "an import",
  fork: "a fork",
};

/** What wrote it, in words: `a push over git`. Unledgered bytes have no operation. */
export function operationLabel(operation: string | null, kind: StorageHoldKind): string {
  if (kind === "unledgered") return "writes from before the ledger began";
  if (kind === "copy_lock") return "a fork copying its source";
  return (operation && OPERATION_LABEL[operation]) ?? operation ?? "an unknown write";
}

/** Bytes, in decimal units as the storage limits are: `1.5 GB`, `320 MB`, `12 kB`, `7 bytes`. */
export function formatBytes(bytes: number): string {
  const units: [number, string][] = [
    [1e9, "GB"],
    [1e6, "MB"],
    [1e3, "kB"],
  ];
  const negative = bytes < 0;
  const size = Math.abs(bytes);
  for (const [scale, unit] of units) {
    if (size >= scale) {
      const value = size / scale;
      const shown = value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, "");
      return `${negative ? "-" : ""}${shown} ${unit}`;
    }
  }
  return `${negative ? "-" : ""}${size} ${size === 1 ? "byte" : "bytes"}`;
}

/** An age in seconds, short: `40 s`, `12 min`, `3 h`, `2 d`. */
export function formatAge(seconds: number | null): string {
  if (seconds == null) return "before the ledger";
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 172_800) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86_400)} d`;
}

/** A hold as the page links to it: `reservation:srv_...`. */
export function holdKey(kind: StorageHoldKind, id: string): string {
  return `${kind}:${id}`;
}

/** The kind and id a link or form names, or null. */
export function parseHoldKey(raw: string | null): { kind: StorageHoldKind; id: string } | null {
  if (!raw) return null;
  const at = raw.indexOf(":");
  if (at <= 0) return null;
  const kind = raw.slice(0, at) as StorageHoldKind;
  const id = raw.slice(at + 1).trim();
  if (!HOLD_KINDS.includes(kind) || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) return null;
  return { kind, id };
}

/** The release form: which hold, and why. */
export function parseRelease(key: string, why: string): Parsed<{ kind: StorageHoldKind; id: string; reason: string }> {
  const hold = parseHoldKey(key);
  if (!hold) return { ok: false, error: "That is not a hold sudo knows how to name." };
  const reason = why.trim();
  if (!reason) return { ok: false, error: "Say why it is being released: it goes in the audit row." };
  if ([...reason].length > MAX_REASON) return { ok: false, error: `Keep it to ${MAX_REASON} characters.` };
  return { ok: true, value: { ...hold, reason } };
}

/** The drift form: how many repositories, 1 to 20. */
export function parseSample(raw: string): number {
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) ? Math.min(20, Math.max(1, value)) : 5;
}

/** The audit log's kind of change for a release (ledgers.ts `AUDIT_ACTIONS`). */
export const RELEASE_ACTION = "storage_released";

/**
 * A release's line in sudo's audit log (billing's `admin_log`): filed under
 * the charged repository's workspace, or under `storage` when its row is
 * gone and no workspace can be named. It names the hold, the repository,
 * the one written when that is another (a fork, or a copy lock's
 * destination, which may be in another workspace), the reason and the
 * repos service's `storage_recoveries` row, which keeps the inspection as
 * evidence.
 */
export function releaseAuditEntry(hold: { kind: StorageHoldKind; id: string }, recovery: StorageRecovery): AdminLogEntry {
  const path = recovery.evidence?.hold.repo.path ?? null;
  const workspace = path?.split("/")[0] ?? "";
  const named = (id: string, at: string | null) => (at ? `${at} (${id})` : `repository ${id} (gone)`);
  const repo = named(recovery.repoId, path);
  const targetId = recovery.evidence?.hold.target?.id ?? recovery.targetId;
  const written = targetId && targetId !== recovery.repoId ? ` → ${named(targetId, recovery.evidence?.hold.target?.path ?? null)}` : "";
  const bytes = hold.kind === "copy_lock" ? "" : `, ${formatBytes(recovery.bytes)}`;
  const detail = `${kindLabel(hold.kind)} ${hold.id} on ${repo}${written}${bytes}: ${recovery.reason} · storage_recoveries ${recovery.id}`;
  return workspace ? { workspace, action: RELEASE_ACTION, detail } : { account: "storage", action: RELEASE_ACTION, detail };
}

/** How a release went: refused or unanswered (nothing released), or released, with or without its audit line. */
export type ReleaseOutcome =
  | { ok: false; status: 422 | 502; error: string }
  | { ok: true; recovery: StorageRecovery; audited: true }
  | { ok: true; recovery: StorageRecovery; audited: false; auditError: string };

/**
 * Releases a hold, then records it in sudo's audit log. The repos service
 * releases it and writes its `storage_recoveries` row in one batch; the
 * audit line is written only after that succeeded. A failed audit write
 * never turns a release into a failure, since the hold is already gone: it
 * is reported (`audited: false`) and logged, naming the recovery row.
 */
export async function releaseHold(
  calls: { release: ReposAdminApi["release"]; log: BillingAdminApi["log"] },
  hold: { kind: StorageHoldKind; id: string; reason: string },
  staff: string,
  report: (message: string) => void = console.error,
): Promise<ReleaseOutcome> {
  const released = await settle(calls.release(hold.kind, hold.id, staff, hold.reason));
  // Unanswered, it may still have been released, and then its audit line is
  // missing: Released below says which, before anyone tries again.
  if (!released.ok) {
    return {
      ok: false,
      status: 502,
      error: `The repos service did not answer: ${released.error}. It may have released the hold anyway: look for it under Released before trying again, and if it is there, it is not in the audit log.`,
    };
  }
  if (!released.value.ok) return { ok: false, status: 422, error: released.value.error.message };
  const recovery = released.value.value;
  const logged = await settle(calls.log(releaseAuditEntry(hold, recovery), staff));
  if (logged.ok && logged.value === true) return { ok: true, recovery, audited: true };
  const auditError = logged.ok ? "billing did not confirm it" : logged.error;
  report(`storage hold ${holdKey(hold.kind, hold.id)} released by ${staff} (storage_recoveries ${recovery.id}) but not in the audit log: ${auditError}`);
  return { ok: true, recovery, audited: false, auditError };
}

/**
 * What the page says after a release, from the link the release redirects
 * to: `done=released&what=…`, and `unaudited=<recovery id>` when the audit
 * log missed it.
 */
export function releasedNotice(params: URLSearchParams): { done: string; auditMissed: string | null } | null {
  if (params.get("done") !== "released") return null;
  const done = `Released ${params.get("what") ?? "the hold"}. It is in the audit log, and its row, with the inspection, is under Released.`;
  const recovery = params.get("unaudited");
  if (recovery == null) return { done, auditMissed: null };
  const row = /^[A-Za-z0-9_-]{1,80}$/.test(recovery) ? ` (storage_recoveries ${recovery})` : "";
  return {
    done: `Released ${params.get("what") ?? "the hold"}.`,
    auditMissed: `The release is done, but billing did not record it in the audit log, so it is not listed there. Its row${row}, with who, why and the inspection, is under Released below, and sudo's logs have the error. Do not release it again: it is gone.`,
  };
}
