import { isCodeownersPath } from "@g1t/contracts";

import type { Route } from "./+types/blob";
import { page } from "../../lib/meta";
import { CodeownersFileErrors } from "../../components/codeowners";
import { BlobView } from "../../components/repo-view";
import { highlightLines } from "../../lib/highlight.server";
import { repos, work } from "../../lib/services.server";
import { redirectIfBranchRenamed } from "../../lib/branch-redirect.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${params["*"]} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const file = params["*"] ?? "";
  const wantsBlame = new URL(request.url).searchParams.has("blame");
  const [found, blame, list, checked] = await Promise.all([
    repos.blob(path, viewer, params.ref, file),
    wantsBlame ? repos.blame(path, viewer, params.ref, file) : null,
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
  if (blame?.ok && blob.text != null) {
    return {
      blob,
      html: null,
      blame: { blame: blame.value, lines: await highlightLines(blob.path, blob.text) },
      branches,
      codeowners,
    };
  }
  return {
    blob,
    html: blob.text == null ? null : await highlightLines(blob.path, blob.text),
    blame: null,
    branches,
    codeowners,
  };
}

export default function Blob({ loaderData, params }: Route.ComponentProps) {
  const { codeowners, blob } = loaderData;
  // Its errors' lines are marked, when they are this file's.
  const own = codeowners != null && codeowners.path === blob.path;
  return (
    <BlobView
      blob={blob}
      html={loaderData.html}
      blame={loaderData.blame}
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
