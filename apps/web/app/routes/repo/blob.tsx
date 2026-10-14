import { isCodeownersPath } from "@g1t/contracts";

import type { Route } from "./+types/blob";
import { page } from "../../lib/meta";
import { CodeownersFileErrors } from "../../components/codeowners";
import { BlobView } from "../../components/repo-view";
import type { ShownBlame } from "../../lib/commit-people";
import { useArrived } from "../../lib/use-arrived";
import { highlightLines } from "../../lib/highlight.server";
import { repos, work } from "../../lib/services.server";
import { showCommits } from "../../lib/commit-people.server";
import { redirectIfBranchRenamed } from "../../lib/branch-redirect.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  const tags = page(args, { title: `${params["*"]} · ${params.owner}/${params.repo} · g1t` });
  // A file's blame is kept out of search indexes; the file itself is not (lib/robots.ts).
  const blame = new URLSearchParams(args.location.search).has("blame");
  return blame ? [...tags, { name: "robots", content: "noindex, nofollow" }] : tags;
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const file = params["*"] ?? "";
  const wantsBlame = new URL(request.url).searchParams.has("blame");
  // A first blame can take seconds (repos walks the file's history), so it
  // streams in after the file; a later one comes from repos' cache at once.
  const blameFound = wantsBlame ? repos.blame(path, viewer, params.ref, file) : null;
  blameFound?.catch(() => null);
  const [found, list, checked] = await Promise.all([
    repos.blob(path, viewer, params.ref, file),
    // For the branch menu; the page still shows without it.
    repos.branches(path, viewer).catch(() => null),
    // A CODEOWNERS file is checked as it is shown; the file shows without it.
    isCodeownersPath(file) ? work.codeownersErrors(path, viewer, params.ref).catch(() => null) : null,
  ]);
  const codeowners = checked?.ok ? checked.value : null;
  const branches = list?.ok ? list.value : null;
  // A branch that was renamed: the same file on its new name.
  if (!found.ok && found.error.code === "not_found") await redirectIfBranchRenamed(request, path, viewer, params.ref);
  const blob = unwrap(found);
  const html = blob.text == null ? null : await highlightLines(blob.path, blob.text);
  // Each line's commit, with every commit's people at once; null when it
  // could not be worked out, and the file shows as it is.
  const blame: Promise<ShownBlame | null> | null =
    blameFound && blob.text != null
      ? blameFound
          .then(async (answered) => (answered.ok ? { ...answered.value, commits: await showCommits(answered.value.commits) } : null))
          .catch(() => null)
      : null;
  return { blob, html, blame, branches, codeowners };
}

export default function Blob({ loaderData, params }: Route.ComponentProps) {
  const { codeowners, blob, html } = loaderData;
  // Its errors' lines are marked, when they are this file's.
  const own = codeowners != null && codeowners.path === blob.path;
  // undefined while the blame is on its way, null when it could not be had.
  const blame = useArrived(loaderData.blame ?? NO_BLAME, undefined);
  return (
    <BlobView
      blob={blob}
      html={html}
      blame={loaderData.blame == null ? null : blame === undefined ? "waiting" : blame === null ? "failed" : { blame, lines: html }}
      branches={loaderData.branches}
      notice={
        codeowners && (
          <CodeownersFileErrors report={codeowners} path={blob.path} base={`/${params.owner}/${params.repo}`} />
        )
      }
      marked={own ? codeowners.errors.map((error) => error.line).filter((line) => line > 0) : undefined}
    />
  );
}

const NO_BLAME: Promise<null> = Promise.resolve(null);
