/**
 * The Storage holds page's words and forms: public storage reservations
 * and copy locks that outlived their write (the repos service's
 * storage_holds.rs decides what is provably abandoned; this only says it).
 * No Workers imports, so it can be tested under Node.
 */
import type { AdminLogEntry, BillingAdminApi, ReposAdminApi, StorageHold, StorageHoldKind, StorageRecovery } from "@g1t/contracts";

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
 * A release's line in sudo's audit log (billing's `admin_log`), as the repos
 * service writes it (storage_holds.rs `audit_line`): filed under the
 * charged repository's workspace, or under `storage` when its row is gone
 * and no workspace can be named. It names the hold, the repository, the one
 * written when that is another (a fork, or a copy lock's destination, which
 * may be in another workspace), the reason and the repos service's
 * `storage_recoveries` row, which keeps the inspection as evidence. Keyed by
 * that row, so billing writes it once whoever sends it. sudo sends it only
 * when the repos service answers without an `audit` (one from before it
 * wrote the line itself).
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
  return workspace ? { workspace, action: RELEASE_ACTION, detail, key: recovery.id } : { account: "storage", action: RELEASE_ACTION, detail, key: recovery.id };
}

/**
 * How a release went: refused or unanswered (nothing released, as far as
 * sudo knows), or released with its audit line `written`, `queued` (the
 * repos service keeps it and sends it until billing confirms it) or
 * `missed` (only when sudo had to write it itself and billing did not
 * confirm it).
 */
export type ReleaseOutcome =
  | { ok: false; status: 422 | 502; error: string }
  | { ok: true; recovery: StorageRecovery; audit: "written" | "queued" }
  | { ok: true; recovery: StorageRecovery; audit: "missed"; auditError: string };

/**
 * Releases a hold. The repos service releases it, writes its
 * `storage_recoveries` row and keeps its line for sudo's audit log in one
 * batch, then sends the line to billing keyed by the row, and again every
 * hour until billing confirms it: a lost answer, or sudo stopping, can
 * neither lose the line nor write it twice. sudo writes nothing itself,
 * unless the repos service answered without an `audit` (one from before it
 * wrote the line, for the length of a deploy), and then keyed the same way.
 */
export async function releaseHold(
  calls: { release: ReposAdminApi["release"]; log: BillingAdminApi["log"] },
  hold: { kind: StorageHoldKind; id: string; reason: string },
  staff: string,
  report: (message: string) => void = console.error,
): Promise<ReleaseOutcome> {
  const released = await settle(calls.release(hold.kind, hold.id, staff, hold.reason));
  // Unanswered, it may still have been released: Released below says
  // which, before anyone tries again, and its line comes with it.
  if (!released.ok) {
    return {
      ok: false,
      status: 502,
      error: `The repos service did not answer: ${released.error}. It may have released the hold anyway: look for it under Released before trying again. If it is there, it is released, and the repos service writes its line in the audit log.`,
    };
  }
  if (!released.value.ok) return { ok: false, status: 422, error: released.value.error.message };
  const recovery = released.value.value;
  if (recovery.audit) return { ok: true, recovery, audit: recovery.audit.sentAt ? "written" : "queued" };
  const logged = await settle(calls.log(releaseAuditEntry(hold, recovery), staff));
  if (logged.ok && logged.value === true) return { ok: true, recovery, audit: "written" };
  const auditError = logged.ok ? "billing did not confirm it" : logged.error;
  report(`storage hold ${holdKey(hold.kind, hold.id)} released by ${staff} (storage_recoveries ${recovery.id}) but not in the audit log: ${auditError}`);
  return { ok: true, recovery, audit: "missed", auditError };
}

/** A recovery row's id as a link carries it, or null if it is not one. */
function recoveryId(raw: string | null): string | null {
  return raw != null && /^[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : null;
}

/**
 * What the page says after a release, from the link the release redirects
 * to: `done=released&what=…`, with `queued=<recovery id>` while billing has
 * not confirmed its audit line, or `unaudited=<recovery id>` when sudo had
 * to write it and billing did not confirm it.
 */
export function releasedNotice(params: URLSearchParams): { done: string; audit: { tone: "info" | "warn"; text: string } | null } | null {
  if (params.get("done") !== "released") return null;
  const what = params.get("what") ?? "the hold";
  const queued = params.get("queued");
  const missed = params.get("unaudited");
  if (queued == null && missed == null) {
    return { done: `Released ${what}. It is in the audit log, and its row, with the inspection, is under Released.`, audit: null };
  }
  const id = recoveryId(queued ?? missed);
  const row = id ? ` (storage_recoveries ${id})` : "";
  if (queued != null) {
    return {
      done: `Released ${what}.`,
      audit: {
        tone: "info",
        text: `Billing has not confirmed its line in the audit log yet. The repos service keeps the line with the release${row} and sends it again every hour until billing confirms it, and it is written there once. Released below says while it waits. Do not release it again: it is gone.`,
      },
    };
  }
  return {
    done: `Released ${what}.`,
    audit: {
      tone: "warn",
      text: `The release is done, but billing did not record it in the audit log, so it is not listed there. Its row${row}, with who, why and the inspection, is under Released below, and sudo's logs have the error. Do not release it again: it is gone.`,
    },
  };
}

/**
 * How long a native fork's copy ordinarily takes at most. A copy lock held
 * longer, while its source refuses every write, is worth a look.
 */
export const SLOW_COPY_SECONDS = 15 * 60;

/**
 * How long after a fork locks its source its reservation may not be there
 * yet: it reserves just after it locks (the repos service's
 * public_storage.rs `FORK_RESERVE_WINDOW_MS`).
 */
export const FORK_RESERVE_WINDOW_SECONDS = 60;

/** A repository a copy lock keeps from taking writes, and what is known of its copy. */
export type BlockedSource = {
  lock: StorageHold;
  /** The fork's own reservation, when it is still listed. */
  fork: StorageHold | null;
  /**
   * The copy did not finish cleanly: the fork's call to the store failed
   * in a way that may still be copying (its reservation ended, and the lock
   * stays for staff), its fork holds no live reservation a minute after it
   * locked (staff may release an ended one at once), or the lock's lease
   * has passed. Its source's writers are told it can take a few hours, as
   * the repos service decides it (public_storage.rs `COPY_LOCKED`).
   */
  stalled: boolean;
  /** Stalled, or held longer than a copy ordinarily takes. */
  attention: boolean;
};

/**
 * Every source a copy lock keeps from taking writes (pushes, commits from
 * the site, merges, pull request updates), oldest first. The lock and its
 * fork's reservation are separate holds: a lock's target is the fork, and
 * a native fork's reservation is charged to the fork itself. `more`: how
 * many holds the listing left out; when it left some out, a fork's
 * reservation missing from it says nothing.
 */
export function blockedSources(holds: StorageHold[], now: string, more = 0): BlockedSource[] {
  const at = Date.parse(now);
  return holds
    .filter((hold) => hold.kind === "copy_lock")
    .map((lock) => {
      const forks = holds.filter((hold) => hold.kind === "reservation" && hold.operation === "fork" && lock.target != null && hold.repo.id === lock.target.id);
      const fork = forks.find((hold) => hold.state === "held") ?? forks[0] ?? null;
      const leaseOver = lock.leaseUntil == null || Date.parse(lock.leaseUntil) < at;
      const unreserved = more === 0 && fork?.state !== "held" && (lock.ageSeconds ?? Number.MAX_SAFE_INTEGER) > FORK_RESERVE_WINDOW_SECONDS;
      const stalled = forks.some((hold) => hold.state === "ended") || unreserved || leaseOver;
      return { lock, fork, stalled, attention: stalled || (lock.ageSeconds ?? 0) >= SLOW_COPY_SECONDS };
    })
    .sort((a, b) => (b.lock.ageSeconds ?? Number.MAX_SAFE_INTEGER) - (a.lock.ageSeconds ?? Number.MAX_SAFE_INTEGER));
}

/** The page's and Overview's line for blocked sources: null when none needs a look. */
export function blockedSummary(blocked: BlockedSource[]): string | null {
  const needing = blocked.filter((source) => source.attention);
  if (needing.length === 0) return null;
  const stalled = needing.filter((source) => source.stalled).length;
  const one = needing.length === 1;
  const them = one ? "A repository takes" : `${needing.length} repositories take`;
  const how =
    stalled === needing.length
      ? `${one ? "its copy" : "their copies"} into a fork did not finish cleanly`
      : stalled > 0
        ? `${stalled} of their copies into a fork did not finish cleanly, and the rest are taking longer than a copy ordinarily does`
        : `${one ? "its copy" : "their copies"} into a fork ${one ? "is" : "are"} taking longer than a copy ordinarily does`;
  const after = stalled > 0 ? " A copy that did not finish cleanly keeps its lock until it is released here, once it is provably abandoned." : "";
  return `${them} no writes: ${how}.${after}`;
}

/** Where a released hold's audit line stands, for the Released list: null once it is written, or when sudo wrote it. */
export function auditState(recovery: StorageRecovery): string | null {
  const audit = recovery.audit;
  if (!audit || audit.sentAt) return null;
  const tries = audit.attempts === 1 ? "1 try" : `${audit.attempts} tries`;
  return `Not in the audit log yet (${tries}${audit.error ? `: ${audit.error}` : ""}): the repos service sends it again every hour.`;
}
