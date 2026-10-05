import { Form, Link, data, useNavigation } from "react-router";

import type { Route } from "./+types/settings-deployments";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { Button, ErrorText, Field, Input } from "../../components/ui";
import { SwitchCard } from "../../components/ui/switch";
import { deployments } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Deployment settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const settings = await deployments.settings({ workspace: params.owner, slug: params.repo }, viewer);
  return { settings: unwrap(settings) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
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

export default function DeploymentSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { settings } = loaderData;
  const busy = useNavigation().state === "submitting";
  const base = `/${params.owner}/${params.repo}`;
  return (
    <div className="max-w-4xl">
      <RepoSettingsHeading base={base} />
      <div className="min-h-6">
        {actionData && "notice" in actionData && <p className="text-sm text-accent">{actionData.notice}</p>}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      </div>

      {!settings.enabled ? (
        <section className="rounded-xl border border-line bg-surface p-5">
          <h2 className="font-medium">Deployments are off</h2>
          <p className="mt-1 text-sm text-muted">
            Turn them on to build production at{" "}
            <span className="font-mono text-fg">{settings.productionUrl.replace("https://", "")}</span> and a preview for
            every pull request. The workspace needs the Deployments plan, under Billing.
          </p>
          <Form method="post" className="mt-4">
            <Button variant="accent" type="submit" name="intent" value="enable" disabled={busy}>
              Turn on deployments
            </Button>
          </Form>
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
            <Button type="submit" disabled={busy}>
              Save
            </Button>
          </Form>

          <section className="mt-10 rounded-xl border border-danger/30 p-5">
            <h2 className="text-sm font-medium">Turn off deployments</h2>
            <p className="mt-1 text-sm text-muted">
              Takes production and every preview down now, and stops building. Nothing of this project's keeps
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
