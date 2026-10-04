import { ExternalLink, Globe, Rocket, RotateCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { Form, Link, data, useNavigation } from "react-router";

import type { Deployment, DeployStatus, FeatureState } from "@g1t/contracts";

import type { Route } from "./+types/deployments";
import { Button, ButtonLink, EmptyState, ErrorText, Field, Input, Textarea, TimeAgo } from "../../components/ui";
import { billing, deployments } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Deployments · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  // Members only; to anyone else the page does not exist.
  if (!role) throw data(null, { status: 404 });
  const path = { namespace: params.owner, name: params.repo };
  const [settings, list, features] = await Promise.all([
    deployments.settings(path, viewer),
    deployments.list(path, viewer),
    billing.features(params.owner, viewer),
  ]);
  const plan = unwrap(features).find((state) => state.plan.feature === "deployments") ?? null;
  return { role, settings: unwrap(settings), ...unwrap(list), plan };
}

/** `KEY=value` lines as an object; blank lines and `#` comments are skipped. */
function parseEnv(text: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const at = trimmed.indexOf("=");
    if (at > 0) vars[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
  }
  return vars;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const intent = form.get("intent");
  const number = form.get("number") ? Number(form.get("number")) : null;
  if (intent === "redeploy") {
    const started = await deployments.redeploy(user, path, number);
    return started.ok ? { notice: "Build started." } : { error: started.error.message };
  }
  if (intent === "take-down") {
    const done = await deployments.takeDown(user, path, number);
    return done.ok ? { notice: "Taken down." } : { error: done.error.message };
  }
  if (intent === "enable" || intent === "disable") {
    const saved = await deployments.updateSettings(user, path, { enabled: intent === "enable" });
    return saved.ok
      ? { notice: intent === "enable" ? "Deployments are on. Production is building." : "Deployments are off, and every app is down." }
      : { error: saved.error.message };
  }
  const on = (name: string) => form.get(name) === "on";
  const saved = await deployments.updateSettings(user, path, {
    previews: on("previews"),
    production: on("production"),
    buildCommand: String(form.get("buildCommand") ?? ""),
    outputDir: String(form.get("outputDir") ?? ""),
    buildEnv: parseEnv(String(form.get("buildEnv") ?? "")),
    idleDays: Number(form.get("idleDays")),
  });
  return saved.ok ? { notice: "Saved." } : { error: saved.error.message };
}

const STATUS: Record<DeployStatus, { label: string; tone: string }> = {
  queued: { label: "Queued", tone: "text-muted" },
  building: { label: "Building", tone: "text-warn" },
  ready: { label: "Live", tone: "text-accent" },
  failed: { label: "Failed", tone: "text-danger" },
  skipped: { label: "Skipped", tone: "text-faint" },
};

function StatusDot({ status }: { status: DeployStatus }) {
  const { label, tone } = STATUS[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${tone}`}>
      <span className={`size-1.5 rounded-full bg-current ${status === "building" ? "animate-pulse" : ""}`} />
      {label}
    </span>
  );
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
            {settings.productionUrl.replace("https://", "")}
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
            Production goes up from <span className="font-mono text-fg">{settings.productionUrl.replace("https://", "")}</span>{" "}
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
                <AppActions number={null} up={!!production} busy={busy} />
              }
            />
            <div className="rounded-xl border border-line bg-surface p-5">
              <h2 className="text-sm font-medium">Previews</h2>
              <p className="mt-0.5 text-xs text-faint">
                {settings.previews
                  ? `One per open pull request; down when it closes or after ${settings.idleDays} days without a visit.`
                  : "Off for this repository."}
              </p>
              {previews.length === 0 ? (
                <p className="mt-4 text-sm text-muted">No previews are up.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line">
                  {previews.map((app) => (
                    <li key={app.url} className="flex items-center gap-3 py-2 text-sm">
                      <Link to={`${base}/pull/${app.number}`} className="font-medium hover:underline">
                        #{app.number}
                      </Link>
                      <a href={app.url} className="min-w-0 truncate font-mono text-xs text-muted hover:text-fg">
                        {app.url.replace("https://", "")}
                      </a>
                      <span className="ml-auto shrink-0">
                        <AppActions number={app.number} up busy={busy} compact />
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

          <SettingsForm settings={settings} busy={busy} />

          <section className="mt-10 rounded-xl border border-danger/30 p-5">
            <h2 className="text-sm font-medium">Turn off deployments</h2>
            <p className="mt-1 text-sm text-muted">
              Takes production and every preview down now, and stops building. Nothing of this repository's keeps
              running or costing anything. The workspace's plan stays on; turn it off under Billing.
            </p>
            <Form method="post" className="mt-3">
              <Button variant="quiet" type="submit" name="intent" value="disable" disabled={busy}>
                Turn off deployments
              </Button>
            </Form>
          </section>
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
        Turn on Deployments for the {owner} workspace and every repository in it can have previews for each pull
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
            {app.url.replace("https://", "")}
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

function AppActions({ number, up, busy, compact }: { number: number | null; up: boolean; busy: boolean; compact?: boolean }) {
  return (
    <Form method="post" className="flex items-center gap-2">
      {number != null && <input type="hidden" name="number" value={number} />}
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
            {build.kind === "production" ? "Production" : `Preview of #${build.number}`}
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

function SettingsForm({ settings, busy }: { settings: Route.ComponentProps["loaderData"]["settings"]; busy: boolean }) {
  const env = Object.entries(settings.buildEnv)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  return (
    <Form method="post" className="mt-10 space-y-5">
      <h2 className="text-sm font-medium text-muted">Settings</h2>
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4 hover:border-line-strong">
          <input type="checkbox" name="production" defaultChecked={settings.production} className="mt-1 accent-accent" />
          <span>
            <span className="block text-sm font-medium">Production</span>
            <span className="mt-1 block text-sm text-muted">Deploy the default branch on every push.</span>
          </span>
        </label>
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4 hover:border-line-strong">
          <input type="checkbox" name="previews" defaultChecked={settings.previews} className="mt-1 accent-accent" />
          <span>
            <span className="block text-sm font-medium">Previews</span>
            <span className="mt-1 block text-sm text-muted">A preview for every open pull request, linked on it.</span>
          </span>
        </label>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <Field label="Build command" hint="Instead of the project's own build script.">
          <Input name="buildCommand" defaultValue={settings.buildCommand ?? ""} placeholder="npm run build" />
        </Field>
        <Field label="Output directory" hint="For a static site; found by itself when empty.">
          <Input name="outputDir" defaultValue={settings.outputDir ?? ""} placeholder="dist" />
        </Field>
        <Field label="Idle days" hint="A preview no one visits for this long comes down.">
          <Input name="idleDays" type="number" min={1} max={90} defaultValue={settings.idleDays} />
        </Field>
      </div>
      <Field
        label="Build variables"
        hint="KEY=value, one per line. The build runs with them; they are not secret, so keep keys in Secrets."
      >
        <Textarea name="buildEnv" rows={4} defaultValue={env} className="font-mono" placeholder="NODE_ENV=production" />
      </Field>
      <Button type="submit" disabled={busy}>
        Save settings
      </Button>
    </Form>
  );
}
