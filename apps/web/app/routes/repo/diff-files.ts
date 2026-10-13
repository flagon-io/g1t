/**
 * Some files of a change with their lines, fetched by the diff view as it
 * reaches files a large pull request, commit or comparison was sent
 * without (lib/diff.ts firstScreens, components/diff-view.tsx).
 *
 * `base` and `head` are the commits the page compared, so the answer never
 * changes: it is kept in the data centre's cache once the viewer is known
 * to read the repository, and the browser keeps it too.
 */
import { data } from "react-router";

import type { FileDiff } from "@g1t/contracts";

import type { Route } from "./+types/diff-files";
import { immutable } from "../../lib/immutable.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

const COMMIT = /^[0-9a-f]{40}$/;
/** The most files one request reads; the repos service reads no more than 50. */
export const MAX_PATHS = 20;

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const head = url.searchParams.get("head") ?? "";
  const base = url.searchParams.get("base") ?? "";
  const paths = [...new Set(url.searchParams.getAll("path"))].sort();
  if (!COMMIT.test(head) || (base !== "" && !COMMIT.test(base)) || paths.length === 0 || paths.length > MAX_PATHS) {
    throw data({ error: "Give head (and base) as full commit hashes and 1 to 20 paths." }, { status: 400 });
  }
  const viewer = getViewer(context);
  const repo = unwrap(await repos.get({ namespace: params.owner, name: params.repo }, viewer));
  // With no base the head is compared with its first parent, as the page
  // that sent the file did: a commit's own page, or a change with no
  // shared history.
  const files = await immutable(`diff-files:${repo.id}:${base}:${head}:${paths.join("\n")}`, async () => {
    const compared = await repos.compare(repo.id, viewer, base || null, head, null, paths);
    return compared.ok ? compared.value.files : null;
  });
  if (!files) throw data({ error: "Those files could not be compared." }, { status: 404 });
  return Response.json({ files } satisfies { files: FileDiff[] }, {
    headers: { "cache-control": "private, max-age=31536000, immutable" },
  });
}
