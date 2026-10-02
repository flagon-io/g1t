import { env } from "cloudflare:workers";

import type { Route } from "./+types/blob";
import { BlobView } from "../../components/repo-view";
import { highlight } from "../../lib/highlight.server";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params["*"]} · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  const blob = unwrap(
    await env.REPOS.blob(path, getViewer(context), params.ref, params["*"] ?? ""),
  );
  return {
    blob,
    html: blob.text == null ? null : await highlight(blob.path, blob.text),
  };
}

export default function Blob({ loaderData }: Route.ComponentProps) {
  return <BlobView blob={loaderData.blob} html={loaderData.html} />;
}
