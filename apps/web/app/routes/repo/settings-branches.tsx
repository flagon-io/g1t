import { ChevronRight, ShieldCheck } from "lucide-react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/settings-branches";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { SettingChoice as Choice, SettingsSection as Section, SettingToggle as Toggle } from "../../components/settings-section";
import { Button, ErrorText, TimeAgo } from "../../components/ui";
import { repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Branches and merging · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_protection");
  const path = { namespace: params.owner, name: params.repo };
  const [repo, settings] = await Promise.all([repos.get(path, viewer), work.getSettings(path, viewer)]);
  return { repo: unwrap(repo), settings: unwrap(settings) };
}

/** A whole number from a form field, kept within `min` and `max`. */
function count(value: FormDataEntryValue | null, min: number, max: number): number {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : min;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_protection");
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const on = (name: string) => form.get(name) === "on";
  // Protection belongs to the repository and how its pull requests are
  // handled to the work service; the page is one form over both.
  const repo = await repos.update(user, path, { protected: on("protected") });
  if (!repo.ok) return { saved: false, error: repo.error.message };
  const settings = await work.updateSettings(user, path, {
    autoMerge: on("autoMerge"),
    requireUpToDate: on("requireUpToDate"),
    requiredApprovals: count(form.get("requiredApprovals"), 0, 6),
    countAgentApprovals: on("countAgentApprovals"),
    allowIgnoringChecks: !on("requireChecks"),
    agentReview: on("agentReview"),
    maxRevisions: count(form.get("maxRevisions"), 0, 5),
    mergeQueue: on("mergeQueue"),
  });
  return settings.ok ? { saved: true, error: null } : { saved: false, error: settings.error.message };
}

export default function BranchSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { repo, settings } = loaderData;
  const saving = useNavigation().state === "submitting";
  const branch = repo.defaultBranch;
  const base = `/${repo.namespace}/${repo.name}`;
  const archived = Boolean(repo.archivedAt);
  return (
    <>
      <RepoSettingsHeading base={base} />
      <Form method="post" className="max-w-4xl">
        <fieldset disabled={archived} className="min-w-0 space-y-8">
          <Section title="Branch protection" about={`Rules for ${branch}, the branch everything lands on.`}>
            <Toggle name="protected" on={repo.protected} title={`Require a pull request to change ${branch}`}>
              Pushing to {branch} is refused, for members and agents alike, and git says why. Changes reach it only by
              merging a pull request. The first push to an empty repository is still allowed.
            </Toggle>
            <Choice
              name="requiredApprovals"
              value={settings.requiredApprovals}
              title="Required approvals"
              options={[
                [0, "None"],
                [1, "1"],
                [2, "2"],
                [3, "3"],
              ]}
            >
              How many reviewers must approve before a pull request can merge. A reviewer who has since asked for
              changes blocks it, and nobody approves their own.
            </Choice>
            <Toggle name="countAgentApprovals" on={settings.countAgentApprovals} title="A g1t agent's approval counts">
              With this off, required approvals have to come from people, and an agent's review is advice.
            </Toggle>
            <Toggle name="requireChecks" on={!settings.allowIgnoringChecks} title="Require acceptance checks to pass">
              With this off, a member can choose to merge although the issue's checks failed or have not finished. With
              it on, nobody can.
            </Toggle>
            <Toggle
              name="requireUpToDate"
              on={settings.requireUpToDate}
              title="Require pull requests to be up to date before merging"
            >
              With this off, a pull request can be merged after {branch} has moved: g1t brings it up to date as part of
              merging, and asks you only if there is a conflict it cannot resolve. With it on, it has to catch up first
              and its checks run again on the result, so what lands is exactly what was checked.
            </Toggle>
            <Toggle name="mergeQueue" on={settings.mergeQueue} title="Merge through a queue">
              Merging adds a pull request to the queue instead of changing {branch} at once. g1t tests it together with
              every pull request ahead of it, several combinations at a time, and {branch} only ever moves to a
              combination whose checks passed. One that fails leaves the queue and goes back to its author, and the ones
              behind it are tested again without it.
            </Toggle>
          </Section>

          <Section
            title="g1t agents"
            about="What happens to a pull request a g1t agent makes, from the moment it is ready."
          >
            <Toggle name="agentReview" on={settings.agentReview} title="Review by a second agent">
              A different agent reads each change and posts comments on lines, a summary and a verdict. If it asks for
              changes, the author is sent back to make them. With this off, review is left to people.
            </Toggle>
            <Choice
              name="maxRevisions"
              value={settings.maxRevisions}
              title="Revisions before asking you"
              options={[
                [0, "None"],
                [1, "1"],
                [2, "2"],
                [3, "3"],
                [5, "5"],
              ]}
            >
              How many times an agent is sent back to fix failed checks or address a review before g1t stops and the
              pull request says it needs you.
            </Choice>
            <Toggle name="autoMerge" on={settings.autoMerge} title="Merge automatically when ready">
              A g1t agent's pull request lands without anyone pressing merge once every rule above is met. With this
              off, it waits for a member. Pull requests from people and from other agents always wait.
            </Toggle>
            <Link
              to={`${base}/settings/guardrails`}
              className="group flex items-center gap-3 rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-surface"
            >
              <ShieldCheck size={16} className="shrink-0 text-accent" />
              <span className="min-w-0 grow">
                <span className="block text-sm font-medium">Guardrails</span>
                <span className="mt-0.5 block text-sm text-muted">
                  What agents may reach, run and spend while they work on this repository.
                </span>
              </span>
              <ChevronRight size={16} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
            </Link>
          </Section>

          <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
            <Button type="submit" disabled={saving || archived}>
              {saving ? "Saving…" : "Save settings"}
            </Button>
            {actionData?.saved && <span className="text-sm text-muted">Saved.</span>}
            <ErrorText>{actionData?.error}</ErrorText>
            {settings.updatedBy && settings.updatedAt && !actionData && (
              <span className="text-xs text-faint">
                Merge rules last changed by <span className="font-mono">{settings.updatedBy}</span>{" "}
                <TimeAgo at={settings.updatedAt} />
              </span>
            )}
          </div>
        </fieldset>
      </Form>
    </>
  );
}
