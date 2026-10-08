import { ChevronRight, ShieldCheck } from "lucide-react";
import { Suspense } from "react";
import { Await, Form, Link } from "react-router";

import type { Route } from "./+types/settings-branches";
import { page } from "../../lib/meta";
import { AddCiPrompt } from "../../components/add-ci";
import { CodeownersReportPanel, CodeownersReportSkeleton } from "../../components/codeowners";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { RequiredChecksPicker } from "../../components/required-checks";
import { SettingChoice as Choice, SettingsSection as Section, SettingToggle as Toggle } from "../../components/settings-section";
import { ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { actions, repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Branches and merging · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up; to anyone without a role here the page does not exist.
  const { access } = await requireInsider(context, params, "manage_protection");
  const path = { namespace: params.owner, name: params.repo };
  const [repo, settings, seen, workflows] = await Promise.all([
    repos.get(path, viewer),
    work.getSettings(path, viewer),
    work.seenChecks(path, viewer),
    actions.workflows(path, viewer),
  ]);
  // Streamed: the CODEOWNERS file is read and checked on its own time.
  const codeowners = work
    .codeownersErrors(path, viewer)
    .then((found) => (found.ok ? found.value : null))
    .catch(() => null);
  return {
    codeowners,
    repo: unwrap(repo),
    settings: unwrap(settings),
    // The names to choose required checks from: what reported lately.
    seen: seen.ok ? seen.value : [],
    // Nothing to require until something runs: the page offers to add CI.
    noChecks: workflows.ok && workflows.value.length === 0 && seen.ok && seen.value.length === 0,
    canPush: access.can.push,
  };
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
    requiredChecks: form.getAll("requiredChecks").map(String),
    requireUpToDate: on("requireUpToDate"),
    requiredApprovals: count(form.get("requiredApprovals"), 0, 6),
    countAgentApprovals: on("countAgentApprovals"),
    allowIgnoringChecks: on("bypassChecks"),
    agentReview: on("agentReview"),
    maxRevisions: count(form.get("maxRevisions"), 0, 5),
    mergeQueue: on("mergeQueue"),
    holdLowConfidence: on("holdLowConfidence"),
    requireCodeOwnerReview: on("requireCodeOwnerReview"),
  });
  return settings.ok ? { saved: true, error: null } : { saved: false, error: settings.error.message };
}

export default function BranchSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { repo, settings, seen, noChecks, canPush, codeowners } = loaderData;
  const branch = repo.defaultBranch;
  const base = `/${repo.namespace}/${repo.name}`;
  const archived = Boolean(repo.archivedAt);
  return (
    <>
      <RepoSettingsHeading base={base} />
      {/* Its own form, so outside the settings one. */}
      {noChecks && (
        <div className="mb-8 max-w-4xl">
          <AddCiPrompt owner={repo.namespace} repo={repo.name} canAdd={canPush && !archived} />
        </div>
      )}
      <Form method="post" className="max-w-4xl">
        <fieldset disabled={archived} className="min-w-0 space-y-8">
          <Section title="Branch protection" about={`Rules for ${branch}, the branch every pull request merges into. They hold for people and agents alike.`}>
            <Toggle name="protected" on={repo.protected} title={`Require a pull request to change ${branch}`}>
              Pushing to {branch} is refused, for members and agents alike, and git says why. Changes reach it only by
              merging a pull request. The first push to an empty repository is still allowed.
            </Toggle>
            <RequiredChecksPicker
              required={settings.requiredChecks ?? []}
              seen={seen}
              mergeQueue={settings.mergeQueue}
              disabled={archived}
            />
            <p className="-mt-4 text-sm text-muted">
              Code scanning results and dependency review gate merges the same way: require the <strong>Code scanning</strong> and{" "}
              <strong>Dependency review</strong> checks here once they have reported on a pull request. When each one fails is set in{" "}
              <Link to={`/${repo.namespace}/${repo.name}/security/settings`} className="underline underline-offset-2 hover:text-fg">
                Security settings
              </Link>
              .
            </p>
            <Toggle name="bypassChecks" on={settings.allowIgnoringChecks} title="Allow bypassing required checks">
              Someone who may merge can tick a box to merge although a required check failed or has not finished, and
              the pull request says who did. With this off, nobody can, and auto-merge never does.
            </Toggle>
            <Toggle
              name="requireUpToDate"
              on={settings.requireUpToDate}
              title="Require branches to be up to date before merging"
            >
              With this off, a pull request can be merged after {branch} has moved: g1t brings it up to date as part of
              merging, and asks you only if there is a conflict it cannot resolve. With it on, it has to catch up first
              and its required checks pass again on the result, so what lands is exactly what was checked.
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
            <Toggle
              name="requireCodeOwnerReview"
              on={settings.requireCodeOwnerReview ?? false}
              title="Require review from code owners"
            >
              A pull request waits until the owners of every file it changes, as the CODEOWNERS file on {branch} names
              them, have approved.
            </Toggle>
            <Toggle name="countAgentApprovals" on={settings.countAgentApprovals} title="g1t's approval counts">
              With this off, required approvals have to come from people, and an agent's review is advice.
            </Toggle>
            <Toggle name="mergeQueue" on={settings.mergeQueue} title="Merge through a queue">
              Merging adds a pull request to the queue instead of changing {branch} at once. g1t builds it together with
              every pull request ahead of it, several combinations at a time, and runs the workflows that run on{" "}
              <code className="text-fg">merge_group</code> on each. {branch} only ever moves to a combination whose
              required checks passed. One that fails leaves the queue and goes back to its author.
            </Toggle>
          </Section>

          <Section
            id="codeowners"
            title="CODEOWNERS"
            about={`Who owns which files, read from ${branch}. Owners are asked to review changes to their files.`}
          >
            <Suspense fallback={<CodeownersReportSkeleton />}>
              <Await resolve={codeowners}>
                {(report) => <CodeownersReportPanel report={report} base={base} branch={branch} />}
              </Await>
            </Suspense>
          </Section>

          <Section
            title="g1t"
            about="What happens to a pull request g1t makes, from the moment it is ready. Its checks are the same workflows, and the rules above hold."
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
              How many times an agent is sent back to fix a failed check, with what its jobs printed, or to address a
              review, before g1t stops and the pull request says it needs you. After that, only a required check that
              still fails holds it.
            </Choice>
            <Toggle name="autoMerge" on={settings.autoMerge} title="Merge automatically when ready">
              A pull request g1t made lands without anyone pressing merge once every rule above is met, its required
              checks included. With this off, it waits for a member. Pull requests from people and from other agents
              always wait.
            </Toggle>
            <Toggle
              name="holdLowConfidence"
              on={settings.holdLowConfidence}
              title="Ask a person before merging low-confidence changes"
            >
              g1t rates how sure it is of each change an agent finishes, from its required checks, revisions, review,
              tests, size and guardrails. One it rates low waits for a member to approve it, instead of merging by itself
              or joining the queue, and shows on Mission control as needing you.
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
            <SubmitButton pending="Saving…" disabled={archived}>
              Save settings
            </SubmitButton>
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
