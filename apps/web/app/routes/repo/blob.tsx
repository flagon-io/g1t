import { isCodeownersPath } from "@g1t/contracts";
import { useEffect, useState } from "react";

import type { Route } from "./+types/blob";
import { page } from "../../lib/meta";
import { CodeownersFileErrors } from "../../components/codeowners";
import { BlobView } from "../../components/repo-view";
import type { ShownBlame } from "../../lib/commit-people";
import { highlightLines } from "../../lib/highlight.server";
import { repos, work } from "../../lib/services.server";
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
  // The blame itself is fetched by the page once the file shows
  // (routes/repo/blame-data.ts): a first one can take longer than the
  // page's stream may stay open.
  return { blob, html, wantsBlame: wantsBlame && blob.text != null, branches, codeowners };
}

export default function Blob({ loaderData, params }: Route.ComponentProps) {
  const { codeowners, blob, html, wantsBlame } = loaderData;
  // Its errors' lines are marked, when they are this file's.
  const own = codeowners != null && codeowners.path === blob.path;
  const blame = useBlame(wantsBlame ? `/${params.owner}/${params.repo}/blame/${encodeURIComponent(blob.ref)}/${encodePath(blob.path)}` : null);
  return (
    <BlobView
      blob={blob}
      html={html}
      blame={blame === null ? null : typeof blame === "string" ? blame : { blame, lines: html }}
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

/** The blame at `url`: "waiting" until it comes, "failed" when it could not
 * be had, null when none was asked for. */
function useBlame(url: string | null): ShownBlame | "waiting" | "failed" | null {
  const [answered, setAnswered] = useState<{ url: string; blame: ShownBlame | "failed" } | null>(null);
  useEffect(() => {
    if (!url) return;
    const stop = new AbortController();
    fetch(url, { signal: stop.signal, headers: { accept: "application/json" } })
      .then(async (response) => {
        const body = (await response.json()) as { blame: ShownBlame | null };
        setAnswered({ url, blame: response.ok && body.blame ? body.blame : "failed" });
      })
      .catch(() => {
        if (!stop.signal.aborted) setAnswered({ url, blame: "failed" });
      });
    return () => stop.abort();
  }, [url]);
  if (!url) return null;
  return answered?.url === url ? answered.blame : "waiting";
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
