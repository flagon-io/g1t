/**
 * A branch, tag or commit of a repository as one archive: a zip
 * (`archive/<ref>.zip`, the Files page's Download ZIP) or a gzipped tar
 * (`archive/<ref>.tar.gz`), its files under `<repo>-<ref>/` as
 * `git archive` would name them, executables and symlinks kept as they are
 * in git. For anyone who can see the repository.
 *
 * The REST API's `GET /repos/{owner}/{repo}/tarball/{ref}` and
 * `/zipball/{ref}` redirect here with `?token=`, a link the repos service
 * made for someone who can read the repository (services/repos
 * archive_links.rs), good for one commit for ten minutes with no session:
 * that is how `actions/checkout` downloads a private repository in a job
 * container without git. Those archives are named as GitHub's are,
 * `<owner>-<repo>-<short sha>/`.
 *
 * Made on request and not kept, so it is capped: a repository past the caps
 * is cloned instead.
 */
import type { Route } from "./+types/archive";
import { cloneUrl } from "../../lib/addresses";
import { addresses } from "../../lib/addresses.server";
import { contentDisposition } from "../../lib/content-safety";
import { repos } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";
import { tarGz } from "../../lib/tar";
import { ZIP_MODES, zip } from "../../lib/zip";

/** The most files, and bytes in all, an archive is made of. */
const MAX_FILES = 10_000;
// The bytes, their base64 and the archive are all held at once, in a Worker of 128 MB.
const MAX_BYTES = 24 * 1024 * 1024;
/** Blobs read per call to the repository, and calls at once. */
const PER_READ = 100;
const READS_AT_ONCE = 8;

const FORMATS = [
  { suffix: ".tar.gz", type: "application/x-gzip" },
  { suffix: ".zip", type: "application/zip" },
] as const;

function refused(status: number, message: string): Response {
  return new Response(`${message}\n`, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

/** What the archive is of, once whoever asked may have it. */
type Source = { repoId: string; fullName: string; label: string };

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const asked = params["*"] ?? "";
  const format = FORMATS.find((candidate) => asked.endsWith(candidate.suffix) && asked.length > candidate.suffix.length);
  if (!format) return refused(404, "Ask for <branch, tag or commit>.zip or <branch, tag or commit>.tar.gz.");
  const ref = asked.slice(0, -format.suffix.length);
  const token = new URL(request.url).searchParams.get("token");
  let source: Source;
  if (token) {
    // A link from the API: one commit, named as GitHub names its archives.
    const grant = await repos.openArchiveToken({ namespace: params.owner, name: params.repo }, token).catch(() => null);
    if (!grant || grant.commit !== ref) return refused(403, "This download link has ended or is not for this commit. Ask the API for a new one.");
    source = { repoId: grant.repoId, fullName: `${grant.namespace}/${grant.name}`, label: `${grant.namespace}-${grant.name}-${grant.commit.slice(0, 7)}` };
  } else {
    const viewer = getViewer(context);
    const repo = await repos.get({ namespace: params.owner, name: params.repo }, viewer).catch(() => null);
    if (!repo?.ok) return refused(404, "There is no such repository, or you cannot see it.");
    // A branch name can hold slashes; the folder and file name cannot.
    source = { repoId: repo.value.id, fullName: `${repo.value.namespace}/${repo.value.name}`, label: `${repo.value.name}-${ref.replaceAll("/", "-")}` };
  }
  const listed = await repos.listFiles(source.repoId, ref, MAX_FILES + 1, { links: true }).catch(() => null);
  if (!listed?.commit) return refused(404, `There is no branch, tag or commit named ${ref}.`);
  const clone = `git clone ${cloneUrl(addresses(), source.fullName)}`;
  if (listed.truncated || listed.files.length > MAX_FILES) {
    return refused(413, `It has more than ${MAX_FILES.toLocaleString("en-US")} files, too many for a download. Clone it instead: ${clone}`);
  }
  const files = listed.files.filter((file): file is (typeof listed.files)[number] & { hash: string } => file.hash != null);
  const unique = [...new Set(files.map((file) => file.hash))];
  const bytes = new Map<string, Uint8Array>();
  let total = 0;
  let tooLarge = false;
  const batches: string[][] = [];
  for (let at = 0; at < unique.length; at += PER_READ) batches.push(unique.slice(at, at + PER_READ));
  // A few reads at a time, each taking the next batch, until all are read or it is too large.
  const reader = async () => {
    for (let batch = batches.shift(); batch && !tooLarge; batch = batches.shift()) {
      for (const blob of await repos.rawBlobs(source.repoId, batch, MAX_BYTES)) {
        total += blob.size;
        if (total > MAX_BYTES || (blob.data == null && blob.size > 0)) tooLarge = true;
        else
          bytes.set(
            blob.hash,
            Uint8Array.from(atob(blob.data ?? ""), (c) => c.charCodeAt(0)),
          );
      }
    }
  };
  await Promise.all(Array.from({ length: READS_AT_ONCE }, reader));
  if (tooLarge) return refused(413, `It is over ${MAX_BYTES / 1024 / 1024} MB, too large for a download. Clone it instead: ${clone}`);
  const entries = files.map((file) => ({ path: `${source.label}/${file.path}`, data: bytes.get(file.hash) ?? new Uint8Array(), kind: file.kind }));
  const archive =
    format.suffix === ".zip"
      ? await zip(entries.map((entry) => ({ ...entry, mode: ZIP_MODES[entry.kind ?? "blob"] })))
      : await tarGz(entries, { mtime: listed.date ? Date.parse(listed.date) / 1000 || 0 : 0, comment: listed.commit });
  return new Response(archive, {
    headers: {
      "content-type": format.type,
      // A ref may hold quotes; the header never does.
      "content-disposition": contentDisposition(`${source.label}${format.suffix}`),
      // A commit's files never change; a branch's do.
      "cache-control": /^[0-9a-f]{40}$/.test(ref) ? "private, max-age=31536000, immutable" : "private, no-cache",
    },
  });
}
