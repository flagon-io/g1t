import type { Route } from "./+types/blob";
import { page } from "../../lib/meta";
import { BlobView } from "../../components/repo-view";
import { highlight, highlightLines } from "../../lib/highlight.server";
import { repos } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `${params["*"]} · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const path = { namespace: params.owner, name: params.repo };
  const file = params["*"] ?? "";
  const wantsBlame = new URL(request.url).searchParams.has("blame");
  const [found, blame] = await Promise.all([
    repos.blob(path, viewer, params.ref, file),
    wantsBlame ? repos.blame(path, viewer, params.ref, file) : null,
  ]);
  const blob = unwrap(found);
  if (blame?.ok && blob.text != null) {
    return {
      blob,
      html: null,
      blame: { blame: blame.value, lines: await highlightLines(blob.path, blob.text) },
    };
  }
  return {
    blob,
    html: blob.text == null ? null : await highlight(blob.path, blob.text),
    blame: null,
  };
}

export default function Blob({ loaderData }: Route.ComponentProps) {
  return <BlobView blob={loaderData.blob} html={loaderData.html} blame={loaderData.blame} />;
}
