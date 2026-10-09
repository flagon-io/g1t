/**
 * A file of a repository as it is, for the Raw button, images on a file's
 * page and pictures in a README: `/<owner>/<repo>/raw/<ref>/<path>`. Sends
 * the viewer on to the file at the commit the ref names, on the usercontent
 * origin (lib/usercontent.ts). A public repository's address is the same
 * for everyone; a private one's carries a token for this file alone, made
 * here for someone who can read the repository, good for an hour or two.
 * Without USERCONTENT_KEY a private file is served from here instead,
 * under the same policy.
 */
import { env } from "cloudflare:workers";

import type { Route } from "./+types/raw";
import { addresses } from "../../lib/addresses.server";
import { repos } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";
import { MAX_RAW_BYTES, isCommit, rawHeaders, rawPath, signRaw } from "../../lib/usercontent";

function refused(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = params["*"] ?? "";
  if (!path) return refused(404, "Ask for /<owner>/<repo>/raw/<branch, tag or commit>/<path>.");
  const named = { namespace: params.owner, name: params.repo };
  const found = await repos.get(named, viewer).catch(() => null);
  if (!found?.ok) return refused(404, "There is no such repository, or you cannot see it.");
  const repo = found.value;
  // The commit the ref names now, so the file's address never changes.
  let commit = isCommit(params.ref) ? params.ref : null;
  if (!commit) {
    const log = await repos.log(named, viewer, params.ref, 1).catch(() => null);
    commit = log?.ok ? (log.value[0]?.hash ?? null) : null;
  }
  if (!commit) return refused(404, `There is no branch, tag or commit named ${params.ref}.`);
  const file = { owner: repo.namespace, repo: repo.name, ref: commit, path };
  const target = `${addresses().usercontent}${rawPath(file)}`;
  // Kept briefly when it followed a branch, which moves.
  const cache = isCommit(params.ref) ? "private, max-age=86400" : "private, max-age=60";
  if (!repo.isPrivate) return redirect(target, cache);
  if (env.USERCONTENT_KEY) {
    const token = await signRaw(env.USERCONTENT_KEY, file, repo.id);
    return redirect(`${target}?token=${encodeURIComponent(token)}`, "private, max-age=600");
  }
  const raw = await repos.rawFile(repo.id, commit, path, MAX_RAW_BYTES).catch(() => null);
  if (!raw) return refused(404, `There is no such file, or it is over ${MAX_RAW_BYTES / 1024 / 1024} MB. Clone the repository for it.`);
  const bytes = Uint8Array.from(atob(raw.data), (c) => c.charCodeAt(0));
  const headers = rawHeaders(path, bytes);
  headers.set("cache-control", "private, max-age=60");
  return new Response(bytes, { headers });
}

function redirect(location: string, cache: string): Response {
  return new Response(null, { status: 302, headers: { location, "cache-control": cache } });
}
