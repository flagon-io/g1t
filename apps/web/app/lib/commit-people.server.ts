/**
 * The one place commits get their people (lib/commit-people.ts): every
 * page that shows a commit's author asks here, once for all its commits.
 * One identity call per page for the addresses not already known, and
 * each answer kept a minute in the isolate, so a page of fifty commits by
 * three people asks about three addresses, and the next page asks about
 * none. A failure matches nobody: the names on the commits are shown.
 */
import type { Commit, EmailOwner } from "@g1t/contracts";

import { type ShownCommit, addressesToMatch, showCommit } from "./commit-people";
import { accounts } from "./services.server";

/** How long an answer is kept: an address can be confirmed or removed. */
const KEEP_MS = 60_000;
/** Addresses kept at most; the oldest go first. */
const MAX_KEPT = 5_000;
/** `email_owners` takes at most this many at once. */
const BATCH = 200;

/** Each address's owner, or null for nobody, until `until`. */
const kept = new Map<string, { until: number; owner: EmailOwner | null }>();

function keep(email: string, owner: EmailOwner | null) {
  kept.delete(email);
  kept.set(email, { until: Date.now() + KEEP_MS, owner });
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
}

/** The accounts behind these (lowercased) addresses; unknown ones are left out. */
export async function emailOwners(emails: string[]): Promise<Record<string, EmailOwner>> {
  const owners: Record<string, EmailOwner> = {};
  const ask: string[] = [];
  const now = Date.now();
  for (const email of new Set(emails)) {
    const hit = kept.get(email);
    if (hit && hit.until > now) {
      if (hit.owner) owners[email] = hit.owner;
    } else {
      ask.push(email);
    }
  }
  for (let start = 0; start < ask.length; start += BATCH) {
    const chunk = ask.slice(start, start + BATCH);
    const found = await accounts.emailOwners(chunk).catch(() => null);
    if (!found) continue;
    for (const email of chunk) {
      const owner = found[email] ?? null;
      keep(email, owner);
      if (owner) owners[email] = owner;
    }
  }
  return owners;
}

/** Commits with their people, in one identity call at most. */
export async function showCommits(commits: Commit[]): Promise<ShownCommit[]> {
  if (commits.length === 0) return [];
  const owners = await emailOwners(addressesToMatch(commits));
  return commits.map((commit) => showCommit(commit, owners));
}

/** One commit, or null, with its people. */
export async function showOneCommit(commit: Commit | null | undefined): Promise<ShownCommit | null> {
  return commit ? (await showCommits([commit]))[0]! : null;
}
