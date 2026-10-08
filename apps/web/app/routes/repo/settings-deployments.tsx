import { Form, Link } from "react-router";

import type { DetectedKind } from "@g1t/contracts";

import type { Route } from "./+types/settings-deployments";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { SwitchCard } from "../../components/ui/switch";
import { neverDeploys } from "../../lib/project-kind";
import { deployments, projects } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Deployment settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Admins; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_integrations");
  const [settings, project] = await Promise.all([
    deployments.settings({ workspace: params.owner, slug: params.repo }, viewer),
    projects.get(params.owner, params.repo, viewer).catch(() => null),
  ]);
  // Set not to deploy in General settings: turning them on is refused until that changes.
  const notDeploying = project?.ok ? neverDeploys(project.value) : false;
  return { settings: unwrap(settings), notDeploying };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_integrations");
  const form = await request.formData();
  const ref = { workspace: params.owner, slug: params.repo };
  const intent = form.get("intent");
  if (intent === "enable" || intent === "disable") {
    const saved = await deployments.updateSettings(user, ref, { enabled: intent === "enable" });
    return saved.ok
      ? { notice: intent === "enable" ? "Deployments are on. Production is building." : "Deployments are off, and every app is down." }
      : { error: saved.error.message };
  }
  const on = (name: string) => form.get(name) === "on";
  const saved = await deployments.updateSettings(user, ref, {
    previews: on("previews"),
    production: on("production"),
    buildCommand: String(form.get("buildCommand") ?? ""),
    outputDir: String(form.get("outputDir") ?? ""),
    idleDays: Number(form.get("idleDays")),
  });
  return saved.ok ? { notice: "Saved." } : { error: saved.error.message };
}

function Check({ name, on, title, children }: { name: string; on: boolean; title: string; children: string }) {
  return (
    <SwitchCard name={name} defaultChecked={on} title={title}>
      {children}
    </SwitchCard>
  );
}

/** What each kind of project is called, and what running it costs, in a line. */
const DETECTED: Record<DetectedKind, { label: string; cost: string }> = {
  static: {
    label: "Static site",
    cost: "Serving its files runs no code, so it adds no requests or CPU time. Builds are metered.",
  },
  html: {
    label: "Plain HTML",
    cost: "Its files are served as they are and run no code, so serving adds no requests or CPU time. Builds are metered.",
  },
  workers: {
    label: "Workers project",
    cost: "Its code runs on every request: requests and CPU time are metered, and so are builds.",
  },
};

/** What g1t found the project to be at its last build, and what that costs. */
function Detected({ kind }: { kind: DetectedKind | null }) {
  const found = kind ? DETECTED[kind] : null;
  return (
    <section className="mb-6 rounded-xl border border-line bg-surface p-5">
      <h2 className="text-sm font-medium">What g1t detected</h2>
      <p className="mt-1 text-sm">
        {found ? found.label : <span className="text-muted">Detected at the first build</span>}
      </p>
      <p className="mt-1 text-xs text-muted">
        {found
          ? found.cost
          : "A static site's files cost nothing to serve; a Workers project's requests and CPU time are metered. Builds are metered either way."}
      </p>
    </section>
  );
}

export default function DeploymentSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { settings, notDeploying } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="max-w-4xl">
      <RepoSettingsHeading base={base} />
      <div className="min-h-6">
        {actionData && "notice" in actionData && <p className="text-sm text-success">{actionData.notice}</p>}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      </div>

      <Detected kind={settings.detected ?? null} />

      {!settings.enabled ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="font-medium">Deployments are off</h2>
          <p className="mt-1 text-sm text-muted">
            Deployments are opt-in for each project, and nothing builds or runs until you turn them on. Then g1t builds
            production at{" "}
            <span className="font-mono text-fg">{settings.productionUrl.replace("https://", "")}</span> and a preview for
            every pull request. The workspace needs the g1t plan, under Billing.
          </p>
          {notDeploying ? (
            <p className="mt-4 text-sm text-muted">
              This project is set to be something that doesn't deploy, such as a library or a tool. To deploy it, choose
              App or site, deployed on g1t, under{" "}
              <Link to={`${base}/settings#kind`} className="text-fg underline underline-offset-4">
                General
              </Link>{" "}
              first.
            </p>
          ) : (
            <Form method="post" className="mt-4">
              <SubmitButton variant="accent" name="intent" value="enable" pending="Turning on…">
                Turn on deployments
              </SubmitButton>
            </Form>
          )}
        </section>
      ) : (
        <>
          <Form method="post" className="space-y-5">
            <div className="grid gap-3 md:grid-cols-2">
              <Check name="production" on={settings.production} title="Production">
                Deploy the default branch on every push.
              </Check>
              <Check name="previews" on={settings.previews} title="Previews">
                A preview for every branch with an open pull request, linked on it.
              </Check>
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
            <p className="text-sm text-muted">
              Builds and running apps read the{" "}
              <Link to={`${base}/settings/secrets`} className="text-fg hover:underline">
                secrets and variables
              </Link>{" "}
              available to Deployments: each row for Production or Preview, or for all environments.
            </p>
            <SubmitButton name="intent" value="save" pending="Saving…">
              Save
            </SubmitButton>
          </Form>

          <section className="mt-10 rounded-xl border border-danger/30 p-5">
            <h2 className="text-sm font-medium">Turn off deployments</h2>
            <p className="mt-1 text-sm text-muted">
              Takes production and every preview down now, and stops building. Nothing of this project's keeps
              running or costing anything. The workspace's plan stays on; turn it off under Billing.
            </p>
            <Form method="post" className="mt-3">
              <SubmitButton variant="quiet" name="intent" value="disable" pending="Turning off…">
                Turn off deployments
              </SubmitButton>
            </Form>
          </section>
        </>
      )}
    </div>
  );
}
