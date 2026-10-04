/**
 * Where an app is served. Production is `<repo>--<owner>.g1t.page` and a
 * pull request's preview `pr-<n>--<repo>--<owner>.g1t.page`; the first label
 * is also the app's script name in the dispatch namespace, so the
 * dispatcher needs nothing but the hostname to find it.
 */

import { DEPLOYMENTS_DOMAIN, type RepoPath } from "@g1t/contracts";

/** A hostname label is at most this long. */
const MAX_LABEL = 63;

/** Lowercase letters, digits and single hyphens, as a label allows. */
function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** A short, stable fingerprint, for names that must be shortened. */
async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, 4)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The script name, and hostname label, for production (`number` null) or a
 * pull request's preview. Single hyphens inside names are kept; the `--`
 * separators cannot occur in a cleaned name, so two repositories never
 * share one. Names too long for a label are shortened with a fingerprint of
 * the whole.
 */
export async function scriptName(repo: RepoPath, number: number | null): Promise<string> {
  const prefix = number == null ? "" : `pr-${number}--`;
  const full = `${prefix}${clean(repo.name)}--${clean(repo.namespace)}`;
  if (full.length <= MAX_LABEL) return full;
  const tail = `--${await fingerprint(`${repo.namespace}/${repo.name}`)}`;
  return `${prefix}${clean(`${repo.name}-${repo.namespace}`).slice(0, MAX_LABEL - prefix.length - tail.length)}${tail}`.replace(
    /-{3,}/g,
    "--",
  );
}

export function appUrl(script: string): string {
  return `https://${script}.${DEPLOYMENTS_DOMAIN}`;
}
