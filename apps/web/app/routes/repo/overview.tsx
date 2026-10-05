import { ArrowDownLeft, ArrowUpRight, Box, CircleDot, Code2, GitBranch, GitCommitHorizontal, GitPullRequest, Lock, Network, Rocket, RotateCw } from "lucide-react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/overview";
import { host, StatusDot } from "../../components/deploy";
import { Button, ButtonLink, CopyLine, EmptyState, TimeAgo } from "../../components/ui";
import { PullIcon } from "../../components/work";
import { deployments, projects, repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn } from "../../lib/session.server";

const MAX_PULLS = 5;

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const member = roleIn(viewer, params.owner) != null;
  const path = { namespace: params.owner, name: params.repo };
  const ref = { workspace: params.owner, slug: params.repo };
  const [project, settings, list, pulls, log, counts, deps] = await Promise.all([
    projects.get(params.owner, params.repo, viewer),
    member ? deployments.settings(ref, viewer) : null,
    member ? deployments.list(ref, viewer) : null,
    work.listPulls(path, viewer, "open"),
    repos.log(path, viewer, null, 1),
    work.counts(path, viewer),
    projects.dependencies(params.owner, params.repo, viewer),
  ]);
  return {
    member,
    project: project.ok ? project.value : null,
    settings: settings?.ok ? settings.value : null,
    builds: list?.ok ? list.value.deployments : [],
    live: list?.ok ? list.value.live : [],
    pulls: pulls.ok ? pulls.value.slice(0, MAX_PULLS) : [],
    commit: log.ok ? (log.value[0] ?? null) : null,
    open: counts.ok ? counts.value : { issues: 0, pulls: 0 },
    dependencies: deps.ok ? deps.value : { dependsOn: [], usedBy: [] },
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const started = await deployments.redeploy(user, { workspace: params.owner, slug: params.repo }, null);
  return started.ok ? { notice: "Production is building." } : { error: started.error.message };
}

export default function ProjectOverview({ loaderData, actionData, params }: Route.ComponentProps) {
  const { member, project, settings, builds, live, pulls, commit, open, dependencies } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const production = live.find((app) => app.kind === "production") ?? null;
  const previews = live.filter((app) => app.kind === "preview");
  const latestProduction = builds.find((build) => build.kind === "production") ?? null;
  const busy = useNavigation().state === "submitting";
  const source = project?.source.kind === "hosted" ? project.source : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0 space-y-6">
        {/* Production: what the project is, running. */}
        <section className="overflow-hidden rounded-2xl border border-line bg-surface">
          <div className="flex flex-wrap items-start justify-between gap-4 p-6">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-muted uppercase">
                <Rocket size={13} className="text-accent" />
                Production
              </p>
              {production ? (
                <>
                  <a
                    href={production.url}
                    className="mt-2 flex items-center gap-1.5 truncate font-mono text-lg font-medium hover:text-accent"
                  >
                    {host(production.url)}
                    <ArrowUpRight size={16} className="shrink-0 text-faint" />
                  </a>
                  <p className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
                    {latestProduction && <StatusDot status={latestProduction.status} />}
                    <span className="inline-flex items-center gap-1 font-mono">
                      <GitCommitHorizontal size={13} className="text-faint" />
                      {production.commit.slice(0, 7)}
                    </span>
                    <span>
                      deployed <TimeAgo at={production.deployedAt} />
                    </span>
                  </p>
                </>
              ) : settings?.enabled ? (
                <>
                  <p className="mt-2 font-mono text-lg text-muted">{host(settings.productionUrl)}</p>
                  <p className="mt-1.5 text-xs text-muted">
                    {latestProduction ? (
                      <StatusDot status={latestProduction.status} label={latestProduction.status === "failed" ? "The last build failed" : undefined} />
                    ) : (
                      "Not deployed yet. Push to the default branch, or deploy it now."
                    )}
                  </p>
                </>
              ) : (
                <>
                  <p className="mt-2 text-lg font-medium">Not deployed</p>
                  <p className="mt-1 max-w-lg text-sm text-muted">
                    Put {project?.name ?? params.repo} on g1t.page: production from the default branch, and a live
                    preview for every pull request. It runs only while someone visits.
                  </p>
                </>
              )}
            </div>
            {member && (
              <div className="flex shrink-0 items-center gap-2">
                {production && (
                  <ButtonLink to={production.url} variant="accent" reloadDocument>
                    Visit
                    <ArrowUpRight size={14} />
                  </ButtonLink>
                )}
                {settings?.enabled ? (
                  <Form method="post">
                    <Button type="submit" variant="quiet" disabled={busy} title="Build production again from the default branch">
                      <RotateCw size={14} />
                      Redeploy
                    </Button>
                  </Form>
                ) : (
                  <ButtonLink to={`${base}/settings/deployments`} variant="accent">
                    <Rocket size={14} />
                    Deploy
                  </ButtonLink>
                )}
              </div>
            )}
          </div>
          {(actionData && "notice" in actionData) || (actionData && "error" in actionData) ? (
            <p className={`border-t border-line px-6 py-2.5 text-sm ${"error" in actionData ? "text-danger" : "text-accent"}`}>
              {"error" in actionData ? actionData.error : actionData.notice}
            </p>
          ) : null}
          {member && settings?.enabled && (
            <div className="grid border-t border-line text-sm sm:grid-cols-3 sm:divide-x sm:divide-line">
              <Link to={`${base}/deployments`} className="px-6 py-3 hover:bg-raised/50">
                <span className="block text-xs text-muted">Previews up</span>
                <span className="font-medium tabular-nums">{previews.length}</span>
              </Link>
              <Link to={`${base}/deployments`} className="px-6 py-3 hover:bg-raised/50">
                <span className="block text-xs text-muted">Builds</span>
                <span className="font-medium tabular-nums">{builds.length}</span>
              </Link>
              <Link to={`${base}/settings/secrets`} className="px-6 py-3 hover:bg-raised/50">
                <span className="block text-xs text-muted">Secrets and variables</span>
                <span className="font-medium">Manage</span>
              </Link>
            </div>
          )}
        </section>

        {previews.length > 0 && (
          <section>
            <h2 className="text-sm font-medium text-muted">Previews</h2>
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {previews.map((app) => (
                <li key={app.url} className="flex items-center gap-3 px-4 py-3 text-sm">
                  <GitBranch size={14} className="shrink-0 text-faint" />
                  <span className="min-w-0 grow">
                    <a href={app.url} className="block truncate font-mono text-[0.8125rem] hover:text-accent">
                      {host(app.url)}
                    </a>
                    <span className="text-xs text-muted">
                      {app.branch}
                      {app.number != null && (
                        <>
                          {" · "}
                          <Link to={`${base}/pull/${app.number}`} className="hover:underline">
                            #{app.number}
                          </Link>
                        </>
                      )}
                    </span>
                  </span>
                  <span className="shrink-0 text-xs text-faint">
                    <TimeAgo at={app.deployedAt} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section>
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-muted">In progress</h2>
            <Link to={`${base}/pulls`} className="text-xs text-muted hover:text-fg">
              All pull requests
            </Link>
          </div>
          <div className="mt-3">
            {pulls.length === 0 ? (
              <EmptyState title="Nothing in progress">
                Open an issue and assign it to g1t-agent, or push a branch and open a pull request.
              </EmptyState>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
                {pulls.map((pull) => {
                  const preview = previews.find((app) => app.number === pull.number);
                  return (
                    <li key={pull.id}>
                      <Link
                        prefetch="intent"
                        to={`${base}/pull/${pull.number}`}
                        className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-raised"
                      >
                        <PullIcon status={pull.status} />
                        <span className="min-w-0 grow">
                          <span className="block truncate font-medium">{pull.title}</span>
                          <span className="font-mono text-xs text-muted">
                            #{pull.number} · {pull.author.username}
                          </span>
                        </span>
                        {preview && <span className="hidden text-xs text-accent sm:block">Preview live</span>}
                        <span className="w-14 shrink-0 text-right text-xs text-faint">
                          <TimeAgo at={pull.updatedAt} />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        {member && builds.length > 0 && (
          <section>
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-medium text-muted">Recent builds</h2>
              <Link to={`${base}/deployments`} className="text-xs text-muted hover:text-fg">
                All deployments
              </Link>
            </div>
            <ul className="mt-3 divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {builds.slice(0, 4).map((build) => (
                <li key={build.id}>
                  <Link to={`${base}/deployments/${build.id}`} className="flex items-center gap-4 px-4 py-3 text-sm hover:bg-raised">
                    <span className="w-20 shrink-0">
                      <StatusDot status={build.status} />
                    </span>
                    <span className="min-w-0 grow truncate">
                      {build.kind === "production" ? "Production" : `Preview of ${build.branch}`}
                      <span className="ml-2 font-mono text-xs text-faint">{build.commit.slice(0, 7)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-faint">
                      <TimeAgo at={build.createdAt} />
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className="space-y-4 text-sm">
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="text-xs font-medium tracking-wide text-muted uppercase">Source</h2>
          {source && (
            <>
              <Link to={`${base}/code`} className="mt-3 flex items-center gap-2 font-mono text-[0.8125rem] hover:text-accent">
                {project?.private ? <Lock size={14} className="text-faint" /> : <Code2 size={14} className="text-faint" />}
                {source.repo.namespace}/{source.repo.name}
              </Link>
              <p className="mt-1 text-xs text-muted">Hosted on g1t{source.rootDir ? ` · in ${source.rootDir}/` : ""}</p>
              <dl className="mt-4 space-y-2 text-xs">
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Default branch</dt>
                  <dd className="font-mono">{source.defaultBranch}</dd>
                </div>
                {commit && (
                  <div className="flex justify-between gap-3">
                    <dt className="text-muted">Latest commit</dt>
                    <dd className="min-w-0 truncate text-right">
                      <Link to={`${base}/commit/${commit.hash}`} className="font-mono hover:underline">
                        {commit.hash.slice(0, 7)}
                      </Link>
                    </dd>
                  </div>
                )}
              </dl>
              {commit && <p className="mt-2 line-clamp-2 text-xs text-muted">{commit.message.split("\n")[0]}</p>}
              <div className="mt-4">
                <CopyLine text={`git clone https://g1t.sh/${source.repo.namespace}/${source.repo.name}.git`} />
              </div>
            </>
          )}
        </section>

        <section className="grid grid-cols-2 gap-3">
          <Link to={`${base}/issues`} className="rounded-xl border border-line bg-surface p-4 hover:border-line-strong">
            <CircleDot size={14} className="text-faint" />
            <p className="mt-2 text-xl font-semibold tabular-nums">{open.issues}</p>
            <p className="text-xs text-muted">Open issues</p>
          </Link>
          <Link to={`${base}/pulls`} className="rounded-xl border border-line bg-surface p-4 hover:border-line-strong">
            <GitPullRequest size={14} className="text-faint" />
            <p className="mt-2 text-xl font-semibold tabular-nums">{open.pulls}</p>
            <p className="text-xs text-muted">Pull requests</p>
          </Link>
        </section>

        <section className="rounded-xl border border-line bg-surface p-5">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
              <Network size={13} />
              Dependencies
            </h2>
            {member && (
              <Link to={`${base}/settings/dependencies`} className="text-xs text-muted hover:text-fg">
                Manage
              </Link>
            )}
          </div>
          {dependencies.dependsOn.length === 0 && dependencies.usedBy.length === 0 ? (
            <p className="mt-3 text-xs text-muted">
              Uses no other project, and none uses it. Declare one, and builds get its address and agents know what
              depends on what.
            </p>
          ) : (
            <div className="mt-3 space-y-3 text-xs">
              {dependencies.dependsOn.length > 0 && (
                <div>
                  <p className="flex items-center gap-1 text-muted">
                    <ArrowUpRight size={12} /> Depends on
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {dependencies.dependsOn.map((d) => (
                      <li key={d.slug} className="flex items-center justify-between gap-2">
                        <Link to={`/${params.owner}/${d.slug}`} className="font-medium hover:underline">
                          {d.name}
                        </Link>
                        {d.as && <code className="font-mono text-faint">{d.as}</code>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {dependencies.usedBy.length > 0 && (
                <div>
                  <p className="flex items-center gap-1 text-muted">
                    <ArrowDownLeft size={12} /> Used by
                  </p>
                  <ul className="mt-1.5 space-y-1">
                    {dependencies.usedBy.map((d) => (
                      <li key={d.slug}>
                        <Link to={`/${params.owner}/${d.slug}`} className="font-medium hover:underline">
                          {d.name}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </section>

        {project && (
          <section className="rounded-xl border border-line p-5 text-xs text-muted">
            <p className="flex items-center gap-2 font-medium text-fg">
              <Box size={14} className="text-faint" />
              About projects
            </p>
            <p className="mt-1.5">
              A project is what you build and run. Its deployments, environments, secrets and variables belong to it;
              its code lives in its source.{" "}
              <a href="https://docs.g1t.sh/guides/projects/" className="text-fg hover:underline">
                Learn more
              </a>
            </p>
          </section>
        )}
      </aside>
    </div>
  );
}
