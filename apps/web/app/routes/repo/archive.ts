/**
 * Download ZIP: a branch, tag or commit of a repository as one zip, its
 * files under `<repo>-<ref>/` as `git archive` would name them. For anyone
 * who can see the repository. Made on request and not kept, so it is capped:
 * a repository past the caps is cloned instead.
 */
import type { Route } from "./+types/archive";
import { repos } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";
import { zip } from "../../lib/zip";

/** The most files, and bytes in all, an archive is made of. */
const MAX_FILES = 10_000;
// The bytes, their base64 and the zip are all held at once, in a Worker of 128 MB.
const MAX_BYTES = 24 * 1024 * 1024;
/** Blobs read per call to the repository, and calls at once. */
const PER_READ = 100;
const READS_AT_ONCE = 8;

function refused(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const asked = params["*"] ?? "";
  if (!asked.endsWith(".zip") || asked.length <= 4) return refused(404, "Ask for <branch, tag or commit>.zip.");
  const ref = asked.slice(0, -4);
  const repo = await repos.get({ namespace: params.owner, name: params.repo }, viewer).catch(() => null);
  if (!repo?.ok) return refused(404, "There is no such repository, or you cannot see it.");
  const listed = await repos.listFiles(repo.value.id, ref, MAX_FILES + 1).catch(() => null);
  if (!listed?.commit) return refused(404, `There is no branch, tag or commit named ${ref}.`);
  const clone = `git clone https://g1t.sh/${repo.value.namespace}/${repo.value.name}.git`;
  if (listed.truncated || listed.files.length > MAX_FILES) {
    return refused(413, `It has more than ${MAX_FILES.toLocaleString("en-US")} files, too many for a download. Clone it instead: ${clone}`);
  }
  const files = listed.files.filter((file): file is { path: string; hash: string } => file.hash != null);
  const unique = [...new Set(files.map((file) => file.hash))];
  const bytes = new Map<string, Uint8Array>();
  let total = 0;
  let tooLarge = false;
  const batches: string[][] = [];
  for (let at = 0; at < unique.length; at += PER_READ) batches.push(unique.slice(at, at + PER_READ));
  // A few reads at a time, each taking the next batch, until all are read or it is too large.
  const reader = async () => {
    for (let batch = batches.shift(); batch && !tooLarge; batch = batches.shift()) {
      for (const blob of await repos.rawBlobs(repo.value.id, batch, MAX_BYTES)) {
        total += blob.size;
        if (total > MAX_BYTES || (blob.data == null && blob.size > 0)) tooLarge = true;
        else bytes.set(blob.hash, Uint8Array.from(atob(blob.data ?? ""), (c) => c.charCodeAt(0)));
      }
    }
  };
  await Promise.all(Array.from({ length: READS_AT_ONCE }, reader));
  if (tooLarge) return refused(413, `It is over ${MAX_BYTES / 1024 / 1024} MB, too large for a download. Clone it instead: ${clone}`);
  // A branch name can hold slashes; the folder and file name cannot.
  const label = `${repo.value.name}-${ref.replaceAll("/", "-")}`;
  const archive = await zip(files.map((file) => ({ path: `${label}/${file.path}`, data: bytes.get(file.hash) ?? new Uint8Array() })));
  return new Response(archive, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${label}.zip"`,
      // A commit's files never change; a branch's do.
      "cache-control": /^[0-9a-f]{40}$/.test(ref) ? "private, max-age=31536000, immutable" : "private, no-cache",
    },
  });
}
