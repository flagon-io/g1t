import { ArrowLeft, ExternalLink } from "lucide-react";
import { Link, data } from "react-router";

import type { Route } from "./+types/deployment";
import { TimeAgo } from "../../components/ui";
import { deployments } from "../../lib/services.server";
import { getViewer, roleIn } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Deployment · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await deployments.get({ namespace: params.owner, name: params.repo }, params.id, viewer);
  if (!found.ok) throw data(null, { status: 404 });
  return { build: found.value };
}

const WORDS = {
  queued: "Waiting for a sandbox",
  building: "Building",
  ready: "Live",
  failed: "Failed",
  skipped: "Skipped",
} as const;

export default function DeploymentPage({ loaderData, params }: Route.ComponentProps) {
  const { build } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="mx-auto max-w-5xl">
      <Link to={`${base}/deployments`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Deployments
      </Link>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">
        {build.kind === "production" ? "Production" : (
          <>
            Preview of{" "}
            <Link to={`${base}/pull/${build.number}`} className="hover:underline">
              #{build.number}
            </Link>
          </>
        )}
        <span className="ml-3 font-mono text-sm font-normal text-faint">{build.commit.slice(0, 12)}</span>
      </h1>
      <p className="mt-1 text-sm text-muted">
        {WORDS[build.status]} · started <TimeAgo at={build.createdAt} /> by {build.createdBy}
        {build.buildSeconds != null && ` · built in ${build.buildSeconds} s`}
      </p>
      {build.status === "ready" && (
        <a href={build.url} className="mt-3 inline-flex items-center gap-1.5 font-mono text-sm text-accent hover:underline">
          {build.url.replace("https://", "")}
          <ExternalLink size={12} />
        </a>
      )}
      {build.error && (
        <p className="mt-4 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm">{build.error}</p>
      )}
      {build.warnings.length > 0 && (
        <ul className="mt-4 space-y-1 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm">
          {build.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <h2 className="mt-8 text-sm font-medium text-muted">Build log</h2>
      <pre className="mt-3 max-h-[70vh] overflow-auto rounded-xl border border-line bg-bg p-4 font-mono text-xs leading-relaxed text-muted">
        {build.log || (build.status === "queued" || build.status === "building" ? "The log appears when the build finishes." : "No log.")}
      </pre>
    </div>
  );
}
