/**
 * The Storage holds page's words and forms: public storage reservations
 * and copy locks that outlived their write (the repos service's
 * storage_holds.rs decides what is provably abandoned; this only says it).
 * No Workers imports, so it can be tested under Node.
 */
import type { StorageHoldKind } from "@g1t/contracts";

import type { Parsed } from "./forms.ts";

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
