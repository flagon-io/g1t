import { ExternalLink, Globe, Rocket, RotateCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, data, useNavigation } from "react-router";

import type { Deployment, FeatureState } from "@g1t/contracts";

import { host, StatusDot } from "../../components/deploy";

import type { Route } from "./+types/deployments";
import { page } from "../../lib/meta";
import { Button, ButtonLink, EmptyState, ErrorText, TimeAgo } from "../../components/ui";
import { billing, deployments } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Deployments · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  // Members only; to anyone else the page does not exist.
  if (!role) throw data(null, { status: 404 });
  const ref = { workspace: params.owner, slug: params.repo };
  const [settings, list, features] = await Promise.all([
    deployments.settings(ref, viewer),
    deployments.list(ref, viewer),
    billing.features(params.owner, viewer),
  ]);
  const plan = unwrap(features).find((state) => state.plan.feature === "deployments") ?? null;
  return { role, settings: unwrap(settings), ...unwrap(list), plan };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const ref = { workspace: params.owner, slug: params.repo };
  const intent = form.get("intent");
  const branch = form.get("branch") ? String(form.get("branch")) : null;
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

export default function RepoDeployments({ loaderData, actionData, params }: Route.ComponentProps) {
  const { settings, deployments: builds, live, plan } = loaderData;
  const busy = useNavigation().state === "submitting";
  const base = `/${params.owner}/${params.repo}`;
  const production = live.find((app) => app.kind === "production");
  const previews = live.filter((app) => app.kind === "preview");

  return (
    <div className="mx-auto max-w-5xl">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
            <Rocket size={18} className="text-accent" />
            Deployments
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Every pull request gets a live preview on g1t.page, and the default branch goes to production on each push.
            Apps run on Cloudflare only while someone visits them.{" "}
            <a href="https://docs.g1t.sh/guides/deployments/" className="text-fg hover:underline">
              How it works
            </a>
          </p>
        </div>
        {settings.enabled && (
          <a
            href={settings.productionUrl}
            className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 font-mono text-xs text-muted hover:border-line-strong hover:text-fg"
          >
            <Globe size={13} />
            {host(settings.productionUrl)}
          </a>
        )}
      </header>

      <div className="mt-4 min-h-6">
        {actionData && "notice" in actionData && <p className="text-sm text-accent">{actionData.notice}</p>}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      </div>

      {!plan?.on ? (
        <PlanNeeded plan={plan} owner={params.owner} />
      ) : !settings.enabled ? (
        <section className="mt-2 rounded-xl border border-accent/30 bg-accent/5 p-6">
          <h2 className="font-medium">Deploy {params.repo}</h2>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Production goes up from <span className="font-mono text-fg">{host(settings.productionUrl)}</span>{" "}
            as soon as you turn this on, and every open pull request gets its own preview. Workers projects (a{" "}
            <code className="font-mono text-fg">wrangler.jsonc</code>) and static sites deploy without configuration.
          </p>
          <Form method="post" className="mt-4">
            <Button variant="accent" type="submit" name="intent" value="enable" disabled={busy}>
              <Rocket size={14} />
              Turn on deployments
            </Button>
          </Form>
        </section>
      ) : (
        <>
          <section className="mt-2 grid gap-4 md:grid-cols-2">
            <LiveCard
              title="Production"
              hint="The default branch, on every push."
              app={production}
              off={!settings.production}
              actions={
                <AppActions branch={null} up={!!production} busy={busy} />
              }
            />
            <div className="rounded-xl border border-line bg-surface p-5">
              <h2 className="text-sm font-medium">Previews</h2>
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
                    <li key={app.url} className="flex items-center gap-3 py-2 text-sm">
                      <span className="shrink-0">
                        <span className="font-medium">{app.branch}</span>
                        {app.number != null && (
                          <Link to={`${base}/pull/${app.number}`} className="ml-1.5 text-xs text-muted hover:underline">
                            #{app.number}
                          </Link>
                        )}
                      </span>
                      <a href={app.url} className="min-w-0 truncate font-mono text-xs text-muted hover:text-fg">
                        {host(app.url)}
                      </a>
                      <span className="ml-auto shrink-0">
                        <AppActions branch={app.branch} up busy={busy} compact />
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <h2 className="mt-10 text-sm font-medium text-muted">Recent builds</h2>
          <div className="mt-3">
            {builds.length === 0 ? (
              <EmptyState title="No builds yet">Push to the default branch or open a pull request.</EmptyState>
            ) : (
              <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line">
                {builds.map((build) => (
                  <BuildRow key={build.id} build={build} base={base} />
                ))}
              </ul>
            )}
          </div>

          <p className="mt-10 text-sm text-muted">
            Build command, output directory, idle days, and turning deployments off are under{" "}
            <Link to={`${base}/settings/deployments`} className="text-fg hover:underline">
              Settings → Deployments
            </Link>
            . Secrets and config for builds and running apps are under{" "}
            <Link to={`${base}/settings/secrets`} className="text-fg hover:underline">
              Settings → Secrets and variables
            </Link>
            .
          </p>
        </>
      )}
    </div>
  );
}

function PlanNeeded({ plan, owner }: { plan: FeatureState | null; owner: string }) {
  return (
    <section className="mt-2 rounded-xl border border-accent/30 bg-accent/5 p-6">
      <h2 className="font-medium">Deployments are part of a paid plan</h2>
      <p className="mt-1 max-w-2xl text-sm text-muted">
        Turn on Deployments for the {owner} workspace and every project in it can have a preview for each pull
        request and production on g1t.page.
        {plan && ` $${(plan.plan.monthlyCents / 100).toFixed(0)} a month, including:`}
      </p>
      {plan && (
        <ul className="mt-3 grid gap-1.5 text-sm text-muted sm:grid-cols-2">
          {plan.plan.includes.map((line) => (
            <li key={line} className="flex gap-2">
              <span className="text-accent">✓</span>
              {line}
            </li>
          ))}
        </ul>
      )}
      {plan && <p className="mt-3 text-xs text-faint">{plan.plan.overage}</p>}
      <div className="mt-4">
        <ButtonLink variant="accent" to={`/${owner}/-/billing`}>
          See the plan under Billing
        </ButtonLink>
      </div>
    </section>
  );
}

function LiveCard({
  title,
  hint,
  app,
  off,
  actions,
}: {
  title: string;
  hint: string;
  app: { url: string; commit: string; deployedAt: string } | undefined;
  off: boolean;
  actions: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-line bg-surface p-5">
      <h2 className="text-sm font-medium">{title}</h2>
      <p className="mt-0.5 text-xs text-faint">{off ? "Off for this repository." : hint}</p>
      {app ? (
        <>
          <a href={app.url} className="mt-3 flex items-center gap-1.5 font-mono text-sm text-accent hover:underline">
            {host(app.url)}
            <ExternalLink size={12} />
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

function AppActions({ branch, up, busy, compact }: { branch: string | null; up: boolean; busy: boolean; compact?: boolean }) {
  return (
    <Form method="post" className="flex items-center gap-2">
      {branch != null && <input type="hidden" name="branch" value={branch} />}
      <Button variant="quiet" type="submit" name="intent" value="redeploy" disabled={busy} title="Build again from the current head">
        <RotateCw size={13} />
        {!compact && "Redeploy"}
      </Button>
      {up && (
        <Button variant="quiet" type="submit" name="intent" value="take-down" disabled={busy} title="Take it down now">
          <Trash2 size={13} />
          {!compact && "Take down"}
        </Button>
      )}
    </Form>
  );
}

function BuildRow({ build, base }: { build: Deployment; base: string }) {
  return (
    <li>
      <Link to={`${base}/deployments/${build.id}`} className="flex items-center gap-4 px-4 py-3 text-sm hover:bg-surface">
        <span className="w-20 shrink-0">
          <StatusDot status={build.status} />
        </span>
        <span className="min-w-0 grow">
          <span className="block truncate font-medium">
            {build.kind === "production" ? "Production" : `Preview of ${build.branch}`}
            <span className="ml-2 font-mono text-xs font-normal text-faint">{build.commit.slice(0, 8)}</span>
          </span>
          {build.error && <span className="mt-0.5 block truncate text-xs text-muted">{build.error}</span>}
        </span>
        <span className="shrink-0 text-xs text-faint">
          {build.buildSeconds != null && `${build.buildSeconds} s · `}
          <TimeAgo at={build.createdAt} />
        </span>
      </Link>
    </li>
  );
}
