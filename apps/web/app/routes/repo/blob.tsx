import { env } from "cloudflare:workers";

import type { Route } from "./+types/blob";
import { BlobView } from "../../components/repo-view";
import { getViewer, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `${params["*"]} · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const path = { namespace: params.owner, name: params.repo };
  return unwrap(
    await env.REPOS.blob(path, getViewer(context), params.ref, params["*"] ?? ""),
  );
}

export default function Blob({ loaderData }: Route.ComponentProps) {
  return <BlobView blob={loaderData} />;
}
