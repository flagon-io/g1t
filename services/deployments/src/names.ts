/**
 * Where an app is served, the way Vercel names them: production at
 * `<project>-<workspace>.g1t.page`, and a branch's preview at
 * `<project>-git-<branch>-<workspace>.g1t.page`. The first label is also
 * the app's script name in the dispatch namespace, so the dispatcher needs
 * nothing but the hostname to find it. The service makes sure no two apps
 * get the same name; this only spells them. A workspace ending in a domain
 * ending is written without that hyphen (`hostWorkspace`); an app under the
 * older spelling is moved to the new one, and its old name redirects.
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

/**
 * Domain endings a workspace's name often finishes with, as a company's
 * domain does (`acme-com`, `flagon-io`). In a hostname they lose their
 * hyphen: `app-acme-com.g1t.page` reads to browsers as a look-alike of
 * acme.com, and Chrome warns the people most likely to open it, those who
 * visit acme.com, that the page "looks fake".
 */
const DOMAIN_ENDINGS = new Set([
  "com", "net", "org", "io", "co", "dev", "app", "ai", "sh", "xyz", "tech", "cloud", "so", "gg", "me",
  "us", "uk", "de", "ca", "eu", "fr", "nl", "au", "in", "jp", "site", "page", "tools", "studio", "inc",
]);

/** The workspace as a hostname writes it: `flagon-io` as `flagonio`, `acme-co-uk` as `acmecouk`. */
export function hostWorkspace(workspace: string): string {
  const parts = clean(workspace).split("-");
  let at = parts.length;
  while (at > 1 && DOMAIN_ENDINGS.has(parts[at - 1])) at--;
  if (at === parts.length) return parts.join("-");
  return `${parts.slice(0, at - 1).concat(parts.slice(at - 1).join("")).join("-")}`;
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
  const w = hostWorkspace(workspace);
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
