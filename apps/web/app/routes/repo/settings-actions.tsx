import { Form, Link } from "react-router";

import { ACTIONS_ACCESS_LEVELS, APPROVAL_POLICIES } from "@g1t/contracts";
import type { ActionsAccessLevel, ActionsSettingsChange, ApprovalPolicy } from "@g1t/contracts";

import type { Route } from "./+types/settings-actions";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { SettingsSection as Section } from "../../components/settings-section";
import { ErrorText, SubmitButton } from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { RadioGroup, RadioOption } from "../../components/ui/radio-group";
import { page } from "../../lib/meta";
import { actions } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Actions · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  // Admins; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_integrations");
  const settings = await actions.actionsSettings({ namespace: params.owner, name: params.repo }, getViewer(context));
  return { settings: unwrap(settings) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_integrations");
  const form = await request.formData();
  const chosen = String(form.get("defaultPermissions"));
  const permissions = chosen === "write" || chosen === "inherit" ? chosen : "read";
  const policy = String(form.get("approvalPolicy"));
  const change: ActionsSettingsChange = { defaultPermissions: permissions };
  // Only where the workspace allows it is the box there to send.
  if (form.has("pullRequestsShown")) change.canApprovePullRequests = form.get("canApprovePullRequests") === "on";
  if ((APPROVAL_POLICIES as readonly string[]).includes(policy)) change.approvalPolicy = policy as ApprovalPolicy;
  const access = String(form.get("accessLevel"));
  if ((ACTIONS_ACCESS_LEVELS as readonly string[]).includes(access)) change.accessLevel = access as ActionsAccessLevel;
  const saved = await actions.setActionsSettings(user, { namespace: params.owner, name: params.repo }, change);
  return saved.ok ? { saved: true, error: null } : { saved: false, error: saved.error.message };
}

/** Each approval policy, least strict first, and whose runs it holds. */
const POLICY_WORDS: Record<ApprovalPolicy, { label: string; about: string }> = {
  first_time_contributors: {
    label: "First-time contributors",
    about: "Someone outside the workspace who has not had a pull request merged here.",
  },
  outside_contributors: {
    label: "Outside contributors",
    about: "Those, and everyone outside the workspace who cannot push here: pull requests from forks, and from people with Read or Triage.",
  },
  all_external_contributors: {
    label: "All external contributors",
    about: "Everyone outside the workspace, outside collaborators with Write included.",
  },
};

export default function RepoActionsSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const base = `/${params.owner}/${params.repo}`;
  const { settings } = loaderData;
  return (
    <>
      <RepoSettingsHeading base={base} />
      <Form method="post" className="max-w-4xl space-y-8">
        <Section
          title="Workflow permissions"
          about={
            <>
              What the token of a job without <code className="font-mono text-xs">permissions:</code> can do. Workflows and
              jobs that write <code className="font-mono text-xs">permissions:</code> get what they write.
            </>
          }
        >
          <RadioGroup
            name="defaultPermissions"
            defaultValue={settings.defaultChosen ? settings.defaultPermissions : "inherit"}
            className="gap-3"
          >
            <RadioOption
              value="inherit"
              label="As the workspace says"
              description={`Now ${settings.defaultPermissions === "write" ? "read and write" : "read-only"}: the workspace's default for new repositories, or read and write for a repository made before restricted tokens.`}
            />
            <RadioOption
              value="read"
              label="Read repository contents and packages"
              description={
                <>
                  <code className="font-mono">contents: read</code> and <code className="font-mono">packages: read</code>.
                </>
              }
            />
            <RadioOption
              value="write"
              label="Read and write"
              disabled={settings.maxPermissions === "read"}
              description={
                settings.maxPermissions === "read"
                  ? "The workspace holds its repositories to read-only."
                  : "Read and write to everything a job's token can reach in this repository."
              }
            />
          </RadioGroup>
          <p className="text-sm text-muted">
            Whatever a workflow asks for, a pull request from outside the repository's writers gets a token that can only
            read.
          </p>
          <input type="hidden" name="pullRequestsShown" value={settings.workspaceAllowsPullRequests ? "1" : ""} disabled={!settings.workspaceAllowsPullRequests} />
          <CheckboxOption
            name="canApprovePullRequests"
            defaultChecked={settings.canApprovePullRequests}
            disabled={!settings.workspaceAllowsPullRequests}
            label="Allow g1t Actions to create and approve pull requests"
            description={
              settings.workspaceAllowsPullRequests
                ? "Jobs' tokens may open pull requests and approve them. Off unless you turn it on."
                : "The workspace does not allow it: an owner can, in the workspace's Actions settings."
            }
          />
        </Section>

        <Section
          title="Approval for pull requests from outside"
          about={
            <>
              Whose pull requests' runs wait as <span className="text-fg/85">Approval required</span> until someone with the
              Write role approves them. Nothing runs before then, and no token or secret is handed out.
            </>
          }
        >
          <RadioGroup name="approvalPolicy" defaultValue={settings.approvalPolicy} className="gap-3">
            {APPROVAL_POLICIES.map((policy) => (
              <RadioOption
                key={policy}
                value={policy}
                label={
                  <>
                    {POLICY_WORDS[policy].label}
                    {policy === "outside_contributors" && <span className="text-muted">(the default)</span>}
                  </>
                }
                description={POLICY_WORDS[policy].about}
              />
            ))}
          </RadioGroup>
          <p className="text-sm text-muted">
            Members' pull requests never wait, nor does g1t's own work. Each new push to a pull request that waits, waits
            again. See{" "}
            <Link to={`${base}/settings/environments`} className="text-fg underline-offset-2 hover:underline">
              Environments
            </Link>{" "}
            to make deployments wait for a review.
          </p>
        </Section>

        <Section
          title="Access"
          about={
            <>
              Which other repositories' workflows may use this repository's actions (
              <code className="font-mono text-xs">uses: {params.owner}/{params.repo}@main</code>) and reusable workflows while it
              is private. A public repository's actions and workflows are anyone's.
            </>
          }
        >
          <RadioGroup name="accessLevel" defaultValue={settings.accessLevel ?? "none"} className="gap-3">
            <RadioOption
              value="none"
              label="Not accessible"
              description="Only this repository's own workflows use them. The default."
            />
            <RadioOption
              value="organization"
              label={`Accessible from repositories in ${params.owner}`}
              description={`Workflows in ${params.owner}'s other private repositories may use them. A public repository's workflows never can, since their logs are public.`}
            />
          </RadioGroup>
        </Section>

        <div className="sticky bottom-(--tabbar-h) in-data-[keyboard=open]:bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
          <SubmitButton pending="Saving…">Save settings</SubmitButton>
          {actionData?.saved && <span className="text-sm text-muted">Saved.</span>}
          <ErrorText>{actionData?.error}</ErrorText>
        </div>
      </Form>
    </>
  );
}
