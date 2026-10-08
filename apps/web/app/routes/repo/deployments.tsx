import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  GitBranch,
  GitCommitHorizontal,
  Globe,
  Rocket,
  RotateCw,
  Terminal,
  Trash2,
} from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link } from "react-router";

import type { DeploymentEnvironment, FeatureState, RepoDeployment } from "@g1t/contracts";

import { host } from "../../components/deploy";
import { DeploymentStateBadge, DeploymentStateIcon, sourceLabel } from "../../components/deployments-panel";
import { FilterMenu } from "../../components/labels";

import type { Route } from "./+types/deployments";
import { page } from "../../lib/meta";
import { ButtonLink, ComputeNote, ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { Badge } from "../../components/ui/badge";
import { Hint } from "../../components/ui/hint";
import { computeNoteFor } from "../../lib/compute.server";
import { neverDeploys } from "../../lib/project-kind";
import { billing, deployments, projects } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser } from "../../lib/session.server";
import { refusal, requireRepo } from "../../lib/access.server";
import { whyNot } from "../../lib/access";
import {
  type ListFilter,
  SOURCES,
  STATES,
  STATE_WORD,
  SOURCE_LABEL,
  choices,
  environmentLabel,
  environmentUrl,
  isFiltered,
  orderEnvironments,
  pageRange,
  parseFilter,
  shortSha,
  withFilter,
} from "../../lib/deployments";

const API_GUIDE = "https://docs.g1t.sh/guides/deployments-api/";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Deployments · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Anyone who can read the repository: a public one's to anyone, a private one's to people with a role.
  const { access, repo } = await requireRepo(context, params, "read");
  const path = { namespace: repo.namespace, name: repo.name };
  const ref = { workspace: params.owner, slug: params.repo };
  const filter = parseFilter(new URL(request.url).searchParams);
  // A part whose service fails shows as missing; the page stays up.
  const soft = <T,>(promise: Promise<T>): Promise<T | null> =>
    promise.catch((error) => (console.warn("deployments:", error), null));
  // g1t.page's settings and builds are the workspace's members' alone.
  const insider = access.insider;
  const [environments, list, settings, builds, features, computeNote, project] = await Promise.all([
    soft(deployments.environments(path, viewer)),
    soft(deployments.repoDeployments(path, viewer, filter)),
    insider ? soft(deployments.settings(ref, viewer)) : null,
    insider ? soft(deployments.list(ref, viewer)) : null,
    insider ? soft(billing.features(params.owner, viewer)) : null,
    // Builds are compute: said before a deploy is refused for it.
    insider ? soft(computeNoteFor(params.owner, "deploy")) : null,
    soft(projects.get(params.owner, params.repo, viewer)),
  ]);
  // Set not to deploy, in General settings: turning them on waits for that to change.
  const notDeploying = project?.ok ? neverDeploys(project.value) : false;
  // Deployments come with the g1t plan. Someone outside the workspace does
  // not see its plans; the page works without, and the deployments service
  // refuses a deploy the plan does not cover.
  const plan = features?.ok
    ? (features.value.find((state) => state.plan.feature === "plan" || state.plan.feature === "deployments") ?? null)
    : null;
  return {
    can: access.can,
    filter,
    environments: environments?.ok ? { ...environments.value, environments: orderEnvironments(environments.value.environments) } : null,
    list: list?.ok ? list.value : null,
    // g1t.page hosting, for the workspace's members: null when it could not be read.
    pages:
      settings?.ok && builds?.ok
        ? { settings: settings.value, live: builds.value.live, plan, computeNote: computeNote ?? null, notDeploying }
        : null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const ref = { workspace: params.owner, slug: params.repo };
  const intent = form.get("intent");
  const branch = form.get("branch") ? String(form.get("branch")) : null;
  // Deploying is compute (Write); turning deployments on or off is a deployment setting (Admin).
  const refused = await refusal(context, params, intent === "enable" || intent === "disable" ? "manage_integrations" : "run");
  if (refused) return { error: refused };
  if (intent === "redeploy") {
    const started = await deployments.redeploy(user, ref, branch);
    return started.ok ? { notice: "Build started." } : { error: started.error.message };
  }
  if (intent === "take-down") {
    const done = await deployments.takeDown(user, ref, branch);
    return done.ok ? { notice: "Taken down." } : { error: done.error.message };
  }
  if (intent === "enable" || intent === "disable") {
    const saved = await deployments.updateSettings(user, ref, { enabled: intent === "enable" });
    return saved.ok
      ? { notice: intent === "enable" ? "Deployments are on. Production is building." : "Deployments are off, and every app is down." }
      : { error: saved.error.message };
  }
  return { error: "Unknown request." };
}

type Loaded = Route.ComponentProps["loaderData"];
type Pages = NonNullable<Loaded["pages"]>;

export default function RepoDeployments({ loaderData, actionData, params }: Route.ComponentProps) {
  const { environments, list, pages, filter, can } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const total = environments?.total_count ?? list?.total_count ?? 0;
  const envs = environments?.environments ?? [];
  const pagesOn = pages?.settings.enabled ?? false;
  // Anything to show besides how to start: deployments, or g1t.page hosting turned on.
  const any = total > 0 || envs.length > 0 || pagesOn || (pages?.live.length ?? 0) > 0;
  const production = envs.find((env) => env.production_environment && environmentUrl(env));
  const productionUrl = production ? environmentUrl(production) : null;
  const planNeeded = pages?.plan != null && !pages.plan.on && !pages.plan.included && pages.live.length === 0;

  return (
    <div className="mx-auto max-w-5xl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Rocket size={18} className="text-accent" />
            Deployments
            {total > 0 && (
              <span className="rounded-full bg-line px-2 py-px text-xs font-medium tabular-nums text-muted">{total.toLocaleString("en-US")}</span>
            )}
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Where this repository runs, and every deployment to it: builds on g1t.page, g1t Actions jobs with an environment,
            and deployments reported from any other CI.
          </p>
        </div>
        {productionUrl && (
          <a
            href={productionUrl}
            className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-line px-3 py-1.5 font-mono text-xs text-muted hover:border-line-strong hover:text-fg"
          >
            <Globe size={13} className="shrink-0" />
            <span className="truncate">{host(productionUrl)}</span>
          </a>
        )}
      </header>

      <div className="mt-4 min-h-6">
        {actionData && "notice" in actionData && <p className="text-sm text-success">{actionData.notice}</p>}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
        {!actionData && pages && <ComputeNote note={pages.computeNote} />}
      </div>

      {!environments && !list ? (
        <p className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">
          Deployments could not be loaded just now. Reload the page to try again.
        </p>
      ) : !any ? (
        <Start base={base} pages={pages} can={can} owner={params.owner} planNeeded={planNeeded} />
      ) : (
        <>
          {envs.length > 0 && (
            <section aria-labelledby="environments">
              <h2 id="environments" className="text-sm font-semibold">
                Environments <span className="font-normal text-faint">{envs.length}</span>
              </h2>
              <ul className="mt-3 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
                {envs.map((env) => (
                  <EnvironmentCard key={env.name} env={env} base={base} />
                ))}
              </ul>
            </section>
          )}

          <History base={base} list={list} filter={filter} environments={envs} />
        </>
      )}

      {/* g1t.page hosting: its own section once there is anything else to show. */}
      {any && pages && (
        <section aria-labelledby="g1t-page" className="mt-12 border-t border-line pt-8">
          <h2 id="g1t-page" className="flex items-center gap-2 text-sm font-semibold">
            <Globe size={14} className="text-faint" />
            On g1t.page
          </h2>
          {planNeeded ? (
            <PlanNeeded plan={pages.plan} owner={params.owner} quiet />
          ) : !pagesOn ? (
            <PagesOff pages={pages} base={base} can={can} quiet />
          ) : (
            <PagesOn pages={pages} base={base} can={can} />
          )}
        </section>
      )}
    </div>
  );
}

/** Nothing has deployed yet: the two ways to start. */
function Start({
  base,
  pages,
  can,
  owner,
  planNeeded,
}: {
  base: string;
  pages: Pages | null;
  can: Loaded["can"];
  owner: string;
  planNeeded: boolean;
}) {
  return (
    <section className="rounded-xl border border-line bg-surface">
      <div className="border-b border-line px-6 py-5">
        <h2 className="font-medium">No deployments yet</h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          Host it here on g1t.page, or deploy it wherever it runs and report each deployment. Either way they show here, by
          environment.
        </p>
      </div>
      <div className="grid divide-y divide-line md:grid-cols-2 md:divide-x md:divide-y-0">
        <div className="min-w-0 p-6">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Globe size={14} className="text-accent" />
            Host it on g1t.page
          </h3>
          {!pages ? (
            <p className="mt-1.5 text-sm text-muted">
              Members of the workspace can turn on hosting: production from the default branch, and a live preview for every
              pull request.
            </p>
          ) : planNeeded ? (
            <PlanNeeded plan={pages.plan} owner={owner} quiet />
          ) : (
            <PagesOff pages={pages} base={base} can={can} />
          )}
        </div>
        <div className="min-w-0 p-6">
          <h3 className="flex items-center gap-2 text-sm font-medium">
            <Terminal size={14} className="text-accent" />
            Report deployments from your CI
          </h3>
          <p className="mt-1.5 text-sm text-muted">
            A g1t Actions job with an <code className="font-mono text-fg">environment:</code> reports its deployment by
            itself. From any other CI, create a deployment and its statuses with the API.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs leading-relaxed text-muted">
            {"jobs:\n  deploy:\n    environment:\n      name: production\n      url: https://example.com"}
          </pre>
          <a href={API_GUIDE} className="mt-3 inline-flex items-center gap-1 text-sm text-accent hover:underline">
            Reporting deployments <ArrowUpRight size={13} />
          </a>
        </div>
      </div>
    </section>
  );
}

function EnvironmentCard({ env, base }: { env: DeploymentEnvironment; base: string }) {
  const latest = env.latest;
  const current = env.current;
  const url = environmentUrl(env);
  // What it serves, when a newer deployment has not (yet) replaced it.
  const serving = current && latest && current.id !== latest.id ? current : null;
  const filtered = `${base}/deployments?environment=${encodeURIComponent(env.name)}#history`;
  return (
    <li className="flex min-w-0 flex-col rounded-xl border border-line bg-surface p-4">
      <div className="flex min-w-0 items-center gap-2">
        <Link to={filtered} className="min-w-0 truncate font-medium hover:text-accent">
          {environmentLabel(env.name)}
        </Link>
        {env.production_environment && env.name !== "production" && <Badge tone="accent">Production</Badge>}
        {env.transient_environment && <Badge>Transient</Badge>}
        <span className="grow" />
        {latest && <DeploymentStateBadge state={latest.state} />}
      </div>
      {url ? (
        <a href={url} className="mt-2 flex min-w-0 items-center gap-1.5 font-mono text-sm text-accent hover:underline">
          <span className="truncate">{host(url)}</span>
          <ExternalLink size={12} className="shrink-0" />
        </a>
      ) : (
        <p className="mt-2 text-sm text-faint">No address</p>
      )}
      {latest && (
        <dl className="mt-3 space-y-1.5 text-xs text-muted">
          <div className="flex min-w-0 items-center gap-2">
            <dt className="sr-only">Commit</dt>
            <dd className="flex min-w-0 items-center gap-3">
              <Link to={`${base}/commit/${latest.sha}`} className="inline-flex shrink-0 items-center gap-1 font-mono hover:text-fg">
                <GitCommitHorizontal size={13} className="text-faint" />
                {shortSha(latest.sha)}
              </Link>
              <span className="inline-flex min-w-0 items-center gap-1 font-mono">
                <GitBranch size={12} className="shrink-0 text-faint" />
                <span className="truncate">{latest.ref}</span>
              </span>
            </dd>
          </div>
          <div className="flex min-w-0 items-center gap-1">
            <dt className="sr-only">Deployed by</dt>
            <dd className="min-w-0 truncate">
              <Made deployment={latest} base={base} /> · <TimeAgo at={latest.updated_at} />
            </dd>
          </div>
          {serving && (
            <div className="flex min-w-0 items-center gap-1">
              <dt className="sr-only">Serving</dt>
              <dd className="min-w-0 truncate text-faint">
                Serving{" "}
                <Link to={`${base}/deployments/${serving.id}`} className="font-mono hover:text-fg">
                  {shortSha(serving.sha)}
                </Link>{" "}
                since <TimeAgo at={serving.updated_at} />
              </dd>
            </div>
          )}
        </dl>
      )}
      <div className="mt-auto flex items-center gap-3 pt-3 text-xs">
        <Link to={filtered} className="text-muted hover:text-fg">
          {env.deployments_count.toLocaleString("en-US")} {env.deployments_count === 1 ? "deployment" : "deployments"}
        </Link>
        {latest && (
          <Link to={`${base}/deployments/${latest.id}`} className="ml-auto inline-flex items-center gap-0.5 text-muted hover:text-fg">
            Latest
            <ChevronRight size={13} />
          </Link>
        )}
      </div>
    </li>
  );
}

/** Who made a deployment and with what: a person or g1t, and g1t Actions (its run), g1t.page or the API. */
function Made({ deployment, base, link = true }: { deployment: RepoDeployment; base: string; link?: boolean }) {
  const label = sourceLabel(deployment.source);
  return (
    <>
      <span className="text-fg-soft">{deployment.creator}</span> via{" "}
      {link && deployment.source === "actions" && deployment.run_url ? (
        <Link to={deployment.run_url} className="underline-offset-2 hover:text-fg hover:underline">
          {label}
        </Link>
      ) : link && deployment.source === "g1t_page" ? (
        <Link to={`${base}/deployments#g1t-page`} className="underline-offset-2 hover:text-fg hover:underline">
          {label}
        </Link>
      ) : (
        label
      )}
    </>
  );
}

function History({
  base,
  list,
  filter,
  environments,
}: {
  base: string;
  list: Loaded["list"];
  filter: ListFilter;
  environments: DeploymentEnvironment[];
}) {
  const path = `${base}/deployments`;
  const rows = list?.deployments ?? [];
  // The choices of creators and refs: those seen on this page and as each environment's latest.
  const seen = [...rows, ...environments.flatMap((env) => [env.latest, env.current])];
  const envNames = environments.map((env) => env.name);
  if (filter.environment && !envNames.includes(filter.environment)) envNames.push(filter.environment);
  const total = list?.total_count ?? 0;
  const pageCount = list ? Math.max(1, Math.ceil(total / list.per_page)) : 1;
  return (
    <section id="history" aria-labelledby="history-heading" className="mt-10 scroll-mt-20">
      <h2 id="history-heading" className="text-sm font-semibold">
        History
      </h2>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <FilterMenu
          label="Environment"
          active={filter.environment ? environmentLabel(filter.environment) : undefined}
          clearTo={filter.environment ? withFilter(path, filter, "environment", null) : undefined}
          searchPlaceholder="Filter environments"
          emptyText="No environment matches."
          options={envNames.map((name) => ({
            key: name,
            to: withFilter(path, filter, "environment", name),
            keywords: name,
            selected: name === filter.environment,
            label: <span className="truncate">{environmentLabel(name)}</span>,
          }))}
        />
        <FilterMenu
          label="State"
          active={filter.state ? STATE_WORD[filter.state] : undefined}
          clearTo={filter.state ? withFilter(path, filter, "state", null) : undefined}
          searchPlaceholder="Filter states"
          emptyText="No state matches."
          options={STATES.map((state) => ({
            key: state,
            to: withFilter(path, filter, "state", state),
            keywords: `${STATE_WORD[state]} ${state}`,
            selected: state === filter.state,
            label: (
              <>
                <DeploymentStateIcon state={state} size={14} />
                {STATE_WORD[state]}
              </>
            ),
          }))}
        />
        <FilterMenu
          label="Source"
          active={filter.source ? SOURCE_LABEL[filter.source] : undefined}
          clearTo={filter.source ? withFilter(path, filter, "source", null) : undefined}
          searchPlaceholder="Filter sources"
          emptyText="No source matches."
          options={SOURCES.map((source) => ({
            key: source,
            to: withFilter(path, filter, "source", source),
            keywords: `${SOURCE_LABEL[source]} ${source}`,
            selected: source === filter.source,
            label: SOURCE_LABEL[source],
          }))}
        />
        <FilterMenu
          label="Creator"
          active={filter.creator ?? undefined}
          clearTo={filter.creator ? withFilter(path, filter, "creator", null) : undefined}
          searchPlaceholder="Filter creators"
          emptyText="No creator matches."
          options={choices(seen, "creator", filter.creator).map((creator) => ({
            key: creator,
            to: withFilter(path, filter, "creator", creator),
            keywords: creator,
            selected: creator === filter.creator,
            label: <span className="truncate">{creator}</span>,
          }))}
        />
        <FilterMenu
          label="Ref"
          active={filter.ref ?? undefined}
          clearTo={filter.ref ? withFilter(path, filter, "ref", null) : undefined}
          searchPlaceholder="Filter refs"
          emptyText="No ref matches."
          options={choices(seen, "ref", filter.ref).map((ref) => ({
            key: ref,
            to: withFilter(path, filter, "ref", ref),
            keywords: ref,
            selected: ref === filter.ref,
            label: <span className="truncate font-mono text-xs">{ref}</span>,
          }))}
        />
        {isFiltered(filter) && (
          <Link to={`${path}#history`} className="text-xs text-muted hover:text-fg">
            Clear filters
          </Link>
        )}
      </div>

      <div className="mt-3">
        {!list ? (
          <p className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">
            The history could not be loaded just now. Reload the page to try again.
          </p>
        ) : rows.length === 0 ? (
          <div className="rounded-lg border border-dashed border-line px-6 py-12 text-center">
            {isFiltered(filter) ? (
              <>
                <p className="font-medium">No deployments match</p>
                <p className="mt-1.5 text-sm text-muted">
                  Try fewer filters, or{" "}
                  <Link to={`${path}#history`} className="text-fg hover:underline">
                    see every deployment
                  </Link>
                  .
                </p>
              </>
            ) : filter.page > 1 ? (
              <>
                <p className="font-medium">No deployments on this page</p>
                <p className="mt-1.5 text-sm text-muted">
                  <Link to={`${path}#history`} className="text-fg hover:underline">
                    Go to the first page
                  </Link>
                  .
                </p>
              </>
            ) : (
              <>
                <p className="font-medium">No deployments yet</p>
                <p className="mt-1.5 text-sm text-muted">
                  Push to the default branch to build production on g1t.page, or{" "}
                  <a href={API_GUIDE} className="text-fg hover:underline">
                    report a deployment
                  </a>{" "}
                  from your CI.
                </p>
              </>
            )}
          </div>
        ) : (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
            {rows.map((deployment) => (
              <HistoryRow key={deployment.id} deployment={deployment} base={base} />
            ))}
          </ul>
        )}
      </div>

      {list && total > 0 && (
        <nav aria-label="Pages" className="mt-3 flex items-center gap-3 text-xs text-muted">
          <span className="tabular-nums">{pageRange(list.page, list.per_page, total)}</span>
          <span className="grow" />
          {list.page > 1 ? (
            <ButtonLink variant="quiet" to={withFilter(path, filter, "page", list.page - 1)}>
              <ChevronLeft size={14} />
              Previous
            </ButtonLink>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium opacity-50">
              <ChevronLeft size={14} />
              Previous
            </span>
          )}
          {list.page < pageCount ? (
            <ButtonLink variant="quiet" to={withFilter(path, filter, "page", list.page + 1)}>
              Next
              <ChevronRight size={14} />
            </ButtonLink>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-md border border-line px-3.5 py-2 text-sm font-medium opacity-50">
              Next
              <ChevronRight size={14} />
            </span>
          )}
        </nav>
      )}
    </section>
  );
}

function HistoryRow({ deployment, base }: { deployment: RepoDeployment; base: string }) {
  return (
    <li>
      <Link
        to={`${base}/deployments/${deployment.id}`}
        className="flex items-start gap-3 px-4 py-3 text-sm transition-colors hover:bg-surface"
      >
        <span className="mt-0.5">
          <DeploymentStateIcon state={deployment.state} size={16} />
        </span>
        <span className="min-w-0 grow">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="font-medium">{environmentLabel(deployment.environment)}</span>
            <span className={`text-xs ${deployment.state === "failure" || deployment.state === "error" ? "text-danger" : "text-muted"}`}>
              {STATE_WORD[deployment.state]}
            </span>
            {deployment.task !== "deploy" && <Badge>{deployment.task}</Badge>}
          </span>
          <span className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted">
            <span className="inline-flex min-w-0 items-center gap-1 font-mono">
              <GitBranch size={12} className="shrink-0 text-faint" />
              <span className="truncate">{deployment.ref}</span>
            </span>
            <span className="shrink-0 font-mono text-faint">{shortSha(deployment.sha)}</span>
            {deployment.description && <span className="hidden min-w-0 truncate sm:inline">· {deployment.description}</span>}
          </span>
          {deployment.description && <span className="mt-0.5 block truncate text-xs text-muted sm:hidden">{deployment.description}</span>}
          {/* Who and when, under the rest on a narrow screen. */}
          <span className="mt-0.5 block truncate text-xs text-faint sm:hidden">
            <Made deployment={deployment} base={base} link={false} /> · <TimeAgo at={deployment.created_at} />
          </span>
        </span>
        <span className="hidden shrink-0 text-right text-xs text-faint sm:block">
          <span className="block">
            <Made deployment={deployment} base={base} link={false} />
          </span>
          <span className="mt-0.5 block">
            <TimeAgo at={deployment.created_at} />
          </span>
        </span>
      </Link>
    </li>
  );
}

function PagesOn({ pages, base, can }: { pages: Pages; base: string; can: Loaded["can"] }) {
  const { settings, live } = pages;
  const production = live.find((app) => app.kind === "production");
  const previews = live.filter((app) => app.kind === "preview");
  return (
    <>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Every pull request gets a live preview on g1t.page, and the default branch goes to production on each push. Apps run
        only while someone visits them.{" "}
        <a href="https://docs.g1t.sh/guides/deployments/" className="text-fg hover:underline">
          How it works
        </a>
      </p>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <LiveCard
          title="Production"
          hint="The default branch, on every push."
          app={production}
          url={production && settings.primaryDomain ? `https://${settings.primaryDomain}` : undefined}
          off={!settings.production}
          actions={can.run ? <AppActions branch={null} up={!!production} /> : null}
        />
        <div className="min-w-0 rounded-xl border border-line bg-surface p-5">
          <h3 className="text-sm font-medium">Previews</h3>
          <p className="mt-0.5 text-xs text-faint">
            {settings.previews
              ? `One per branch with an open pull request; down when it closes or after ${settings.idleDays} days without a visit.`
              : "Off for this repository."}
          </p>
          {previews.length === 0 ? (
            <p className="mt-4 text-sm text-muted">No previews are up.</p>
          ) : (
            <ul className="mt-3 divide-y divide-line">
              {previews.map((app) => (
                <li key={app.url} className="flex min-w-0 items-center gap-3 py-2 text-sm">
                  <span className="min-w-0 shrink truncate">
                    <span className="font-medium">{app.branch}</span>
                    {app.number != null && (
                      <Link to={`${base}/pull/${app.number}`} className="ml-1.5 text-xs text-muted hover:underline">
                        #{app.number}
                      </Link>
                    )}
                  </span>
                  <a href={app.url} className="hidden min-w-0 truncate font-mono text-xs text-muted hover:text-fg sm:block">
                    {host(app.url)}
                  </a>
                  <span className="ml-auto shrink-0">{can.run && <AppActions branch={app.branch} up compact />}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      <p className="mt-4 text-sm text-muted">
        Its builds are in the history above, under{" "}
        <Link to={`${base}/deployments?source=g1t_page#history`} className="text-fg hover:underline">
          g1t.page
        </Link>
        . Build command, output directory, idle days, and turning hosting off are under{" "}
        <Link to={`${base}/settings/deployments`} className="text-fg hover:underline">
          Settings → Deployments
        </Link>
        . Secrets and config for builds and running apps are under{" "}
        <Link to={`${base}/settings/secrets`} className="text-fg hover:underline">
          Settings → Secrets and variables
        </Link>
        , and production's own domains under{" "}
        <Link to={`${base}/settings/domains`} className="text-fg hover:underline">
          Settings → Domains
        </Link>
        .
      </p>
    </>
  );
}

/** g1t.page hosting is off: what turning it on does, and the button. */
function PagesOff({ pages, base, can, quiet }: { pages: Pages; base: string; can: Loaded["can"]; quiet?: boolean }) {
  return (
    <>
      <p className="mt-1.5 max-w-2xl text-sm text-muted">
        {quiet ? "This repository can also be hosted here. " : ""}
        Once on, production goes up at <span className="font-mono text-fg [overflow-wrap:anywhere]">{host(pages.settings.productionUrl)}</span>{" "}
        and every open pull request gets its own preview. Workers projects (a{" "}
        <code className="font-mono text-fg">wrangler.jsonc</code>) and static sites deploy without configuration.
      </p>
      {pages.notDeploying ? (
        <p className="mt-4 max-w-2xl text-sm text-muted">
          This project is set to be something that doesn't deploy here, such as a library, a tool or an app deployed
          elsewhere. To host it on g1t.page, choose App or site, deployed on g1t, in{" "}
          <Link to={`${base}/settings#kind`} className="text-fg underline underline-offset-4">
            its settings
          </Link>{" "}
          first.
        </p>
      ) : (
        <Form method="post" className="mt-4">
          <Hint label={whyNot(can, "manage_integrations")} disabled={!can.manage_integrations}>
            <SubmitButton
              variant={quiet ? "quiet" : "accent"}
              name="intent"
              value="enable"
              pending="Turning on…"
              disabled={!can.manage_integrations}
            >
              <Rocket size={14} />
              Turn on g1t.page hosting
            </SubmitButton>
          </Hint>
        </Form>
      )}
    </>
  );
}

function PlanNeeded({ plan, owner, quiet }: { plan: FeatureState | null; owner: string; quiet?: boolean }) {
  return (
    <div className={quiet ? "mt-1.5" : "mt-2 rounded-xl border border-accent/30 bg-accent/5 p-6"}>
      {!quiet && <h2 className="font-medium">Deployments are part of a paid plan</h2>}
      <p className="max-w-2xl text-sm text-muted">
        Hosting on g1t.page is part of a paid plan. Turn on Deployments for the {owner} workspace and every project in it can
        have a preview for each pull request and production on g1t.page.
        {plan && ` $${(plan.plan.monthlyCents / 100).toFixed(0)} a month, including:`}
      </p>
      {plan && (
        <ul className="mt-3 grid gap-1.5 text-sm text-muted sm:grid-cols-2">
          {plan.plan.includes.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-success">✓</span>
              {line}
            </li>
          ))}
        </ul>
      )}
      {plan && <p className="mt-3 text-xs text-faint">{plan.plan.overage}</p>}
      <div className="mt-4">
        <ButtonLink variant={quiet ? "quiet" : "accent"} to={`/${owner}/-/billing`}>
          See the plan under Billing
        </ButtonLink>
      </div>
    </div>
  );
}

function LiveCard({
  title,
  hint,
  app,
  url,
  off,
  actions,
}: {
  title: string;
  hint: string;
  app: { url: string; commit: string; deployedAt: string } | undefined;
  /** The project's own domain, when it has one. */
  url?: string;
  off: boolean;
  actions: ReactNode;
}) {
  const href = url ?? app?.url;
  return (
    <div className="min-w-0 rounded-xl border border-line bg-surface p-5">
      <h3 className="text-sm font-medium">{title}</h3>
      <p className="mt-0.5 text-xs text-faint">{off ? "Off for this repository." : hint}</p>
      {app && href ? (
        <>
          <a href={href} className="mt-3 flex min-w-0 items-center gap-1.5 font-mono text-sm text-accent hover:underline">
            <span className="truncate">{host(href)}</span>
            <ExternalLink size={12} className="shrink-0" />
          </a>
          <p className="mt-1 text-xs text-faint">
            <span className="font-mono">{app.commit.slice(0, 8)}</span> · deployed <TimeAgo at={app.deployedAt} />
          </p>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">Not up.</p>
      )}
      {!off && <div className="mt-4">{actions}</div>}
    </div>
  );
}

function AppActions({ branch, up, compact }: { branch: string | null; up: boolean; compact?: boolean }) {
  // Which app's buttons say they are working: production has no branch.
  const app = branch ?? "production";
  return (
    <Form method="post" className="flex items-center gap-2">
      {branch != null && <input type="hidden" name="branch" value={branch} />}
      <input type="hidden" name="app" value={app} />
      <Hint label="Build again from the current head">
        <SubmitButton
          variant="quiet"
          name="intent"
          value="redeploy"
          match={{ app }}
          icon={compact}
          pending="Redeploying…"
          aria-label={compact ? "Redeploy" : undefined}
        >
          <RotateCw size={13} />
          {!compact && "Redeploy"}
        </SubmitButton>
      </Hint>
      {up && (
        <Hint label="Take it down now">
          <SubmitButton
            variant="quiet"
            name="intent"
            value="take-down"
            match={{ app }}
            icon={compact}
            pending="Taking down…"
            aria-label={compact ? "Take down" : undefined}
          >
            <Trash2 size={13} />
            {!compact && "Take down"}
          </SubmitButton>
        </Hint>
      )}
    </Form>
  );
}
