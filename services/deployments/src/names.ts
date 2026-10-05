/**
 * Where an app is served, the way Vercel names them: production at
 * `<project>-<workspace>.g1t.page`, and a branch's preview at
 * `<project>-git-<branch>-<workspace>.g1t.page`. The first label is also
 * the app's script name in the dispatch namespace, so the dispatcher needs
 * nothing but the hostname to find it. The service makes sure no two apps
 * get the same name; this only spells them.
 */

import { DEPLOYMENTS_DOMAIN } from "@g1t/contracts";

/** A hostname label is at most this long. */
const MAX_LABEL = 63;

/** Lowercase letters, digits and single hyphens, as a label allows. */
export function clean(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}

/** A short, stable fingerprint of `text`. */
export async function fingerprint(text: string, bytes = 3): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest).slice(0, bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * The label for production (`branch` null) or a branch's preview. Too long
 * for a label, the branch and then the project are shortened, and a
 * fingerprint of the whole keeps it unique.
 */
export async function label(workspace: string, project: string, branch: string | null): Promise<string> {
  const w = clean(workspace);
  const p = clean(project);
  const b = branch == null ? null : clean(branch);
  const full = b == null ? `${p}-${w}` : `${p}-git-${b}-${w}`;
  if (full.length <= MAX_LABEL) return full;
  const tail = `-${await fingerprint(`${workspace}/${project}/${branch ?? ""}`)}-${w}`.slice(0, 40);
  const room = MAX_LABEL - tail.length;
  const head = b == null ? p : `${p.slice(0, Math.max(8, Math.floor(room / 2)))}-git-${b}`;
  return `${head.slice(0, room).replace(/-+$/, "")}${tail}`;
}

/** The same label made unique, when another app already holds it. */
export async function uniqueLabel(base: string, key: string): Promise<string> {
  const suffix = `-${await fingerprint(key, 2)}`;
  return `${base.slice(0, MAX_LABEL - suffix.length).replace(/-+$/, "")}${suffix}`;
}

export function appHost(script: string): string {
  return `${script}.${DEPLOYMENTS_DOMAIN}`;
}

export function appUrl(script: string): string {
  return `https://${appHost(script)}`;
}
