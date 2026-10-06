/**
 * Choosing what a token, an application or a workspace's token may do:
 * the checklist's fields, read into the scopes identity stores, and the
 * words settings use to show them again.
 *
 * Tokens are classic: a token reaches whatever its owner can, and its
 * scopes say what it may do there. The form posts one `scope` field per
 * ticked box. A higher level of a resource includes the lower ones
 * (`issues:write` gives `issues:read`), so only the highest ticked level
 * of each resource is stored.
 */

import {
  PRESETS,
  SCOPES,
  SCOPE_RESOURCES,
  levelsOf,
  parseScopes,
  presetScopes,
  scopeIncludes,
  scopeLevel,
  scopeResource,
  OAUTH_DEFAULT_SCOPES,
  type PresetId,
  type Scope,
  type ScopeLevel,
  type ScopeResource,
} from "@g1t/contracts/scopes";

const RANK: Record<ScopeLevel, number> = { read: 0, write: 1, run: 2, admin: 3 };

/** Anything with FormData's getters, so tests can pass a plain map. */
export type FormLike = { get(name: string): unknown; getAll(name: string): unknown[] };

/** The fewest scopes that give the same access: the highest level per resource, in table order. */
export function normalizeScopes(scopes: readonly string[]): Scope[] {
  const top = new Map<ScopeResource, Scope>();
  for (const scope of parseScopes(scopes.join(" "))) {
    const held = top.get(scopeResource(scope));
    if (!held || RANK[scopeLevel(scope)] > RANK[scopeLevel(held)]) top.set(scopeResource(scope), scope);
  }
  return SCOPES.map((row) => row.scope).filter((scope) => top.get(scopeResource(scope)) === scope);
}

/** Every scope's top level: what full access ticks. */
export function everyScope(): Scope[] {
  return SCOPE_RESOURCES.map(({ resource }) => {
    const levels = levelsOf(resource);
    return `${resource}:${levels[levels.length - 1]}` as Scope;
  });
}

/**
 * Whether `scope` is given by another ticked box of its resource at a
 * higher level. The checklist shows it ticked and greyed out.
 */
export function impliedBy(ticked: readonly Scope[], scope: Scope): Scope | null {
  return ticked.find((held) => held !== scope && scopeIncludes(held, scope)) ?? null;
}

/** The preset a set of scopes is exactly, if any. Null scopes are full access. */
export function matchingPreset(scopes: readonly string[] | null): PresetId | null {
  if (scopes === null) return "full";
  const mine = normalizeScopes(scopes).join(" ");
  for (const preset of PRESETS) {
    const theirs = presetScopes(preset.id);
    if (theirs && normalizeScopes(theirs).join(" ") === mine) return preset.id;
  }
  return null;
}

export function presetLabel(id: PresetId): string {
  return PRESETS.find((preset) => preset.id === id)?.label ?? id;
}

/** How a token or grant's access reads in a list. */
export function accessSummary(holder: { scopes: readonly string[] | null; legacy: boolean }): string {
  if (holder.scopes === null) return holder.legacy ? "Legacy · full access" : "Full access";
  const preset = matchingPreset(holder.scopes);
  if (preset) return presetLabel(preset);
  const count = normalizeScopes(holder.scopes).length;
  if (count === 0) return "No scopes";
  return count === 1 ? "1 scope" : `${count} scopes`;
}

/** Whether a set of scopes gives anything an admin level gives. */
export function hasDangerous(scopes: readonly string[] | null): boolean {
  return scopes === null || normalizeScopes(scopes).some((scope) => scopeLevel(scope) === "admin");
}

export type GrantInput = { scopes: string[] | null };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * The scopes ticked on the checklist: `preset` = `full` is full access
 * (null); otherwise every `scope` box, unknown names left out.
 */
export function scopesFromForm(form: FormLike, options: { allowFull?: boolean } = {}): Parsed<string[] | null> {
  if (options.allowFull !== false && form.get("preset") === "full") return { ok: true, value: null };
  const scopes = normalizeScopes(form.getAll("scope").map(String));
  if (scopes.length === 0) return { ok: false, error: "Tick at least one scope." };
  return { ok: true, value: scopes };
}

/** What the scope checklist posts, ready for identity. */
export function grantFromForm(form: FormLike, options: { allowFull?: boolean } = {}): Parsed<GrantInput> {
  const scopes = scopesFromForm(form, options);
  if (!scopes.ok) return scopes;
  return { ok: true, value: { scopes: scopes.value } };
}

/** What an application asked for in `scope`; nothing usable means the default set, never admin. */
export function requestedScopes(scope: string | null | undefined): Scope[] {
  const asked = parseScopes(scope ?? "");
  return asked.length > 0 ? asked : [...OAUTH_DEFAULT_SCOPES];
}

/**
 * The scopes kept on the consent page: only what the application asked
 * for, whatever the form says. A box greyed out because a higher one of
 * its resource is ticked is not posted, and needs not be: the higher one
 * gives it.
 */
export function consentedScopes(form: FormLike, requested: readonly Scope[]): Scope[] {
  const ticked = new Set(form.getAll("scope").map(String));
  return normalizeScopes(requested.filter((scope) => ticked.has(scope)));
}

/** Expiry choices for a new token, in days; `never` does not expire. */
export const EXPIRY_CHOICES = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "365", label: "1 year" },
  { value: "never", label: "No expiry" },
] as const;

export const DEFAULT_EXPIRY = "90";

/** Seconds a new token lives, or undefined for no expiry. Anything unknown is the default. */
export function expiryTtl(value: unknown): number | undefined {
  const text = String(value ?? DEFAULT_EXPIRY);
  if (text === "never") return undefined;
  const days = EXPIRY_CHOICES.some((choice) => choice.value === text) ? Number(text) : Number(DEFAULT_EXPIRY);
  return days * 86_400;
}

/** "Expires in 3 days", "Expired", "No expiry". */
export function describeExpiry(expiresAt: string | null, now = Date.now()): string {
  if (!expiresAt) return "No expiry";
  const left = new Date(expiresAt).getTime() - now;
  if (left <= 0) return "Expired";
  const hours = left / 3_600_000;
  if (hours < 1) return "Expires in under an hour";
  const plural = (count: number, unit: string) => `Expires in ${count} ${unit}${count === 1 ? "" : "s"}`;
  if (hours < 48) return plural(Math.round(hours), "hour");
  const days = Math.round(hours / 24);
  if (days < 60) return plural(days, "day");
  const months = Math.round(days / 30);
  if (months < 24) return plural(months, "month");
  return plural(Math.round(days / 365), "year");
}
