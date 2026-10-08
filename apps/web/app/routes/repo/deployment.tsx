import { ArrowLeft, ChevronRight, ExternalLink, FileText, GitBranch, GitCommitHorizontal, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Link, data } from "react-router";

import type { Deployment, DeploymentDetail, DeploymentStatus } from "@g1t/contracts";

import type { Route } from "./+types/deployment";
import { page } from "../../lib/meta";
import { TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Hint } from "../../components/ui/hint";
import { host } from "../../components/deploy";
import { DeploymentStateBadge, DeploymentStateIcon, STATE_TONE, sourceLabel } from "../../components/deployments-panel";
import { deployments } from "../../lib/services.server";
import { getViewer } from "../../lib/session.server";
import { requireRepo } from "../../lib/access.server";
import { STATE_WORD, buildError, environmentLabel, hasPayload, isPageBuild, shortSha } from "../../lib/deployments";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Deployment · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const { repo } = await requireRepo(context, params, "read");
  const path = { namespace: repo.namespace, name: repo.name };
  const soft = <T,>(promise: Promise<T>): Promise<T | null> =>
    promise.catch((error) => (console.warn("deployment:", error), null));
  // A g1t.page build also has its build log and warnings, for the workspace's members.
  const [found, build] = await Promise.all([
    soft(deployments.repoDeployment(path, params.id, viewer)),
    isPageBuild(params.id) ? soft(deployments.get({ workspace: params.owner, slug: params.repo }, params.id, viewer)) : null,
  ]);
  const deployment = found?.ok ? found.value : null;
  const pageBuild = build?.ok ? build.value : null;
  if (!deployment && !pageBuild) throw data(null, { status: 404 });
  return { deployment, build: pageBuild };
}

/** A g1t.page build's status in words. */
const BUILD_WORDS = {
  queued: "Waiting for a sandbox",
  building: "Building",
  ready: "Live",
  replaced: "Replaced by a newer build",
  down: "Taken down",
  failed: "Failed",
  skipped: "Skipped",
} as const;

export default function DeploymentPage({ loaderData, params }: Route.ComponentProps) {
  const { deployment, build } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="mx-auto max-w-5xl">
      <Link to={`${base}/deployments`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} />
        Deployments
      </Link>
      {deployment ? <Reported deployment={deployment} base={base} /> : build && <BuildHeading build={build} base={base} />}
      {build && <BuildDetails build={build} />}
    </div>
  );
}

function Reported({ deployment, base }: { deployment: DeploymentDetail; base: string }) {
  const url = deployment.environment_url;
  const environmentTo = `${base}/deployments?environment=${encodeURIComponent(deployment.environment)}#history`;
  return (
    <>
      <header className="mt-3 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xl font-semibold tracking-tight">
            <Link to={environmentTo} className="hover:text-accent">
              {environmentLabel(deployment.environment)}
            </Link>
            {deployment.number != null && (
              <Link to={`${base}/pull/${deployment.number}`} className="text-base font-normal text-muted hover:underline">
                #{deployment.number}
              </Link>
            )}
            <DeploymentStateBadge state={deployment.state} size={16} className="text-sm" />
          </h1>
          <p className="mt-1 text-sm text-muted">
            {deployment.task === "deploy" ? "Deployment" : <span className="font-mono">{deployment.task}</span>} of{" "}
            <span className="font-mono text-fg-soft">{deployment.ref}</span> by{" "}
            <span className="text-fg-soft">{deployment.creator}</span> via {sourceLabel(deployment.source)},{" "}
            <TimeAgo at={deployment.created_at} />
          </p>
        </div>
        {url && (
          <a
            href={url}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md bg-accent px-3.5 py-2 text-sm font-medium text-bg hover:bg-accent-hover"
          >
            <span className="truncate">{host(url)}</span>
            <ExternalLink size={14} className="shrink-0" />
          </a>
        )}
      </header>

      {deployment.description && (
        <p className="mt-4 max-w-3xl text-sm text-fg-soft [overflow-wrap:anywhere]">{deployment.description}</p>
      )}

      <dl className="mt-6 grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-line bg-line text-sm sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Environment">
          <Link to={environmentTo} className="hover:text-accent">
            {environmentLabel(deployment.environment)}
          </Link>
          {deployment.production_environment && deployment.environment !== "production" && <Badge tone="accent">Production</Badge>}
          {deployment.transient_environment && <Badge>Transient</Badge>}
        </Fact>
        <Fact label="Commit">
          <Link to={`${base}/commit/${deployment.sha}`} className="inline-flex items-center gap-1 font-mono hover:text-accent">
            <GitCommitHorizontal size={13} className="text-faint" />
            {shortSha(deployment.sha)}
          </Link>
          <span className="inline-flex min-w-0 items-center gap-1 font-mono text-muted">
            <GitBranch size={12} className="shrink-0 text-faint" />
            <span className="truncate">{deployment.ref}</span>
          </span>
        </Fact>
        <Fact label="Made by">
          <span className="truncate">{deployment.creator}</span>
          <span className="text-muted">
            via{" "}
            {deployment.source === "actions" && deployment.run_url ? (
              <Link to={deployment.run_url} className="text-fg-soft hover:text-accent hover:underline">
                {sourceLabel(deployment.source)}
              </Link>
            ) : (
              sourceLabel(deployment.source)
            )}
          </span>
        </Fact>
        <Fact label="Updated">
          <TimeAgo at={deployment.updated_at} />
          <span className="text-muted">
            created <TimeAgo at={deployment.created_at} />
          </span>
        </Fact>
      </dl>

      {(deployment.log_url || deployment.run_url) && (
        <p className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
          {deployment.run_url && deployment.source === "actions" && (
            <Link to={deployment.run_url} className="inline-flex items-center gap-1.5 text-muted hover:text-fg">
              <Workflow size={14} className="text-faint" />
              Workflow run
            </Link>
          )}
          {deployment.log_url && !isPageBuild(deployment.id) && (
            <a href={deployment.log_url} className="inline-flex items-center gap-1.5 text-muted hover:text-fg">
              <FileText size={14} className="text-faint" />
              Log
              <ExternalLink size={12} className="text-faint" />
            </a>
          )}
        </p>
      )}

      <section aria-labelledby="statuses" className="mt-8">
        <h2 id="statuses" className="text-sm font-semibold">
          Statuses <span className="font-normal text-faint">{deployment.statuses.length}</span>
        </h2>
        {deployment.statuses.length === 0 ? (
          <p className="mt-3 text-sm text-muted">No statuses yet.</p>
        ) : (
          <ol className="mt-4">
            {deployment.statuses.map((status, index) => (
              <StatusItem key={status.id} status={status} last={index === deployment.statuses.length - 1} />
            ))}
          </ol>
        )}
      </section>

      {hasPayload(deployment.payload) && (
        <details className="group mt-8 rounded-xl border border-line bg-surface">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <ChevronRight size={14} className="text-faint transition-transform group-open:rotate-90" />
            Payload
            <span className="font-normal text-faint">{Object.keys(deployment.payload).length} keys</span>
          </summary>
          <pre className="max-h-[60vh] overflow-auto border-t border-line p-4 font-mono text-xs leading-relaxed text-muted whitespace-pre-wrap [overflow-wrap:anywhere]">
            {JSON.stringify(deployment.payload, null, 2)}
          </pre>
        </details>
      )}
    </>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 bg-surface px-4 py-3">
      <dt className="text-[0.6875rem] text-faint">{label}</dt>
      <dd className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">{children}</dd>
    </div>
  );
}

/** One status on the timeline, oldest at the top, with a line down to the next. */
function StatusItem({ status, last }: { status: DeploymentStatus; last: boolean }) {
  return (
    <li className="relative flex gap-3 pb-5 last:pb-0">
      {!last && <span aria-hidden="true" className="absolute top-6 bottom-1 left-[9px] w-px bg-line" />}
      <span className="relative mt-0.5 flex size-[19px] shrink-0 items-center justify-center bg-bg">
        <DeploymentStateIcon state={status.state} size={18} />
      </span>
      <div className="min-w-0 grow">
        <p className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className={`font-medium ${STATE_TONE[status.state]}`}>{STATE_WORD[status.state]}</span>
          <span className="text-xs text-faint">
            {status.creator} ·{" "}
            <Hint label={new Date(status.created_at).toUTCString()}>
              <span tabIndex={0}>
                <TimeAgo at={status.created_at} />
              </span>
            </Hint>
          </span>
        </p>
        {status.description && <p className="mt-0.5 text-sm text-muted [overflow-wrap:anywhere]">{status.description}</p>}
        {(status.environment_url || status.log_url) && (
          <p className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-xs">
            {status.environment_url && (
              <a href={status.environment_url} className="inline-flex min-w-0 items-center gap-1 font-mono text-accent hover:underline">
                <span className="truncate">{host(status.environment_url)}</span>
                <ExternalLink size={11} className="shrink-0" />
              </a>
            )}
            {status.log_url && (
              <a href={status.log_url} className="inline-flex items-center gap-1 text-muted hover:text-fg">
                <FileText size={11} />
                Log
              </a>
            )}
          </p>
        )}
      </div>
    </li>
  );
}

/** A g1t.page build with no deployment record to head it: its own heading, as before. */
function BuildHeading({ build, base }: { build: Deployment; base: string }) {
  return (
    <>
      <h1 className="mt-3 text-xl font-semibold tracking-tight">
        {build.kind === "production" ? (
          "Production"
        ) : (
          <>
            Preview of <span className="font-mono">{build.branch}</span>
            {build.number != null && (
              <Link to={`${base}/pull/${build.number}`} className="ml-2 text-base font-normal text-muted hover:underline">
                #{build.number}
              </Link>
            )}
          </>
        )}
        <span className="ml-3 font-mono text-sm font-normal text-faint">{build.commit.slice(0, 12)}</span>
      </h1>
      <p className="mt-1 text-sm text-muted">
        {BUILD_WORDS[build.status]} · started <TimeAgo at={build.createdAt} /> by {build.createdBy}
      </p>
      {build.status === "ready" && (
        <a href={build.url} className="mt-3 inline-flex items-center gap-1.5 font-mono text-sm text-accent hover:underline">
          {host(build.url)}
          <ExternalLink size={12} />
        </a>
      )}
    </>
  );
}

/** What only a g1t.page build has: why it failed, its warnings, and its build log. */
function BuildDetails({ build }: { build: Deployment & { log: string | null } }) {
  const error = buildError(build);
  return (
    <section aria-labelledby="build" className="mt-8">
      <h2 id="build" className="flex flex-wrap items-baseline gap-x-2 text-sm font-semibold">
        Build on g1t.page
        <span className="text-xs font-normal text-muted">
          {BUILD_WORDS[build.status]}
          {build.buildSeconds != null && ` · built in ${build.buildSeconds} s`}
        </span>
      </h2>
      {error && (
        <p className="mt-3 rounded-lg border border-danger/30 bg-danger/5 px-4 py-3 text-sm [overflow-wrap:anywhere]">{error}</p>
      )}
      {build.warnings.length > 0 && (
        <ul className="mt-3 space-y-1 rounded-lg border border-warn/30 bg-warn/5 px-4 py-3 text-sm">
          {build.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
      <h3 className="mt-5 text-sm font-medium text-muted">Build log</h3>
      {/* Long lines wrap, so a narrow screen shows the whole log without scrolling sideways. */}
      <pre className="mt-3 max-h-[70vh] overflow-auto whitespace-pre-wrap rounded-xl border border-line bg-bg p-4 font-mono text-xs leading-relaxed text-muted [overflow-wrap:anywhere]">
        {build.log || (build.status === "queued" || build.status === "building" ? "The log appears when the build finishes." : "No log.")}
      </pre>
    </section>
  );
}
