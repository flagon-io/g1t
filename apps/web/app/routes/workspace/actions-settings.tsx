import { Form } from "react-router";

import type { WorkspaceActionsSettings } from "@g1t/contracts";

import type { Route } from "./+types/actions-settings";
import { SettingsSection as Section } from "../../components/settings-section";
import { ErrorText, SubmitButton } from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { page } from "../../lib/meta";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Actions · ${params.owner} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Members may see the policy; owners change it.
  const role = roleIn(viewer, params.owner);
  if (!role) throw new Response(null, { status: 404 });
  const settings = unwrap(await actions.workspaceActionsSettings(params.owner.toLowerCase(), viewer));
  return { settings, owner: role === "owner" };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  if (roleIn(getViewer(context), params.owner) !== "owner") throw new Response(null, { status: 404 });
  const user = requireUser(context, request);
  const form = await request.formData();
  const level = (name: string): "read" | "write" => (form.get(name) === "write" ? "write" : "read");
  const change: Partial<WorkspaceActionsSettings> = {
    defaultPermissions: level("defaultPermissions"),
    maxPermissions: level("maxPermissions"),
    canApprovePullRequests: form.get("canApprovePullRequests") === "on",
  };
  const saved = await actions.setWorkspaceActionsSettings(user, params.owner.toLowerCase(), change);
  return saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error.message };
}

export default function WorkspaceActionsSettingsPage({ loaderData, actionData }: Route.ComponentProps) {
  const { settings, owner } = loaderData;
  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-xl font-semibold tracking-tight">Actions</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          What the token of each workflow job in this workspace's repositories may do when its workflow writes no{" "}
          <code className="font-mono text-xs">permissions:</code>. Each repository can choose for itself under its Settings,
          Actions, within these limits.
        </p>
      </header>
      <Form method="post" className="max-w-4xl space-y-8">
        <fieldset disabled={!owner} className="space-y-8">
          <Section title="Default for new repositories" about="What a repository made from now on gets, until it chooses.">
            <RadioGroup name="defaultPermissions" defaultValue={settings.defaultPermissions} className="gap-3">
              <RadioOption
                value="read"
                label="Read repository contents and packages"
                description={
                  <>
                    <code className="font-mono">contents: read</code> and <code className="font-mono">packages: read</code>.
                    The default.
                  </>
                }
              />
              <RadioOption value="write" label="Read and write" description="Every permission a job's token can have." />
            </RadioGroup>
            <p className="text-sm text-muted">
              Repositories made before restricted tokens keep read and write until someone chooses otherwise.
            </p>
          </Section>

          <Section title="Most a repository may choose" about="No repository's default goes past this.">
            <RadioGroup name="maxPermissions" defaultValue={settings.maxPermissions} className="gap-3">
              <RadioOption value="write" label="Read and write" description="Each repository chooses. The default." />
              <RadioOption
                value="read"
                label="Read only"
                description="Every repository's jobs get read-only tokens unless their workflow writes permissions:."
              />
            </RadioGroup>
          </Section>

          <Section
            title="Pull requests"
            about="Whether a job's token may open pull requests and approve them. Off by default."
          >
            <CheckboxOption
              name="canApprovePullRequests"
              defaultChecked={settings.canApprovePullRequests}
              label="Allow repositories to let g1t Actions create and approve pull requests"
              description="Each repository still turns it on for itself, under its Settings, Actions."
            />
          </Section>
        </fieldset>

        {owner ? (
          <div className="sticky bottom-(--tabbar-h) in-data-[keyboard=open]:bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
            <SubmitButton pending="Saving…">Save settings</SubmitButton>
            {actionData?.saved && <span className="text-sm text-muted">Saved.</span>}
            <ErrorText>{actionData?.error}</ErrorText>
          </div>
        ) : (
          <p className="text-sm text-muted">Only the workspace's owners can change these.</p>
        )}
      </Form>
    </div>
  );
}
