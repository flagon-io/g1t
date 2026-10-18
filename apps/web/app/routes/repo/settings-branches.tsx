import { ChevronRight, Scale, ShieldCheck } from "lucide-react";
import { Suspense } from "react";
import { Await, Form, Link } from "react-router";

import type { CommitMessageDefault } from "@g1t/contracts";

import { allowedMethods, isMergeMethod } from "../../lib/merge";
import { ruleInfo } from "../../lib/rules";

import type { Route } from "./+types/settings-branches";
import { page } from "../../lib/meta";
import { AddCiPrompt } from "../../components/add-ci";
import { CodeownersReportPanel, CodeownersReportSkeleton } from "../../components/codeowners";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { MergeMethodSettings } from "../../components/merge-settings";
import { EnforcementBadge } from "../../components/rules";
import { SettingsSection as Section, SettingToggle as Toggle } from "../../components/settings-section";
import { ErrorText, SubmitButton, TimeAgo } from "../../components/ui";
import { actions, repos, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";

const COMMIT_MESSAGE_DEFAULTS: CommitMessageDefault[] = [
  "default",
  "pull_title",
  "pull_title_and_description",
  "pull_title_and_commits",
  "custom",
];

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Branches and merging · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up: it shows the rules and changes only how ready pull requests merge; to anyone without a role here the page does not exist.
  const { access } = await requireInsider(context, params, "manage_settings");
  const path = { namespace: params.owner, name: params.repo };
  const [repo, settings, seen, workflows] = await Promise.all([
    repos.get(path, viewer),
    work.getSettings(path, viewer),
    // Only for offering to add CI: when either cannot be read, it is not offered.
    part(work.seenChecks(path, viewer), "Checks seen"),
    part(actions.workflows(path, viewer), "Workflows"),
  ]);
  const found = unwrap(repo);
  // What holds for the default branch: shown here, changed in Rules. A
  // failure says so in its place: read as no rules, it would say the
  // branch is unprotected.
  const effective = await part(work.effectiveRules(path, found.defaultBranch, viewer), `The rules for ${found.defaultBranch}`);
  // Streamed: the CODEOWNERS file is read and checked on its own time.
  const codeowners = work
    .codeownersErrors(path, viewer)
    .then((report) => (report.ok ? report.value : null))
    .catch(() => null);
  return {
    codeowners,
    repo: found,
    settings: unwrap(settings),
    effective: isFailed(effective) ? effective : effective.ok ? effective.value : null,
    // Nothing to require until something runs: the page offers to add CI.
    noChecks: !isFailed(workflows) && workflows.ok && workflows.value.length === 0 && !isFailed(seen) && seen.ok && seen.value.length === 0,
    canPush: access.can.push,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_settings");
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const on = (name: string) => form.get(name) === "on";
  // Branch protection is the repository's rulesets' (Settings → Rules):
  // what it holds is sent back as it is, so only how pull requests merge
  // changes here.
  const current = await work.getSettings(path, user);
  if (!current.ok) return { saved: false, error: current.error.message };
  const choice = (name: string, fallback: CommitMessageDefault): CommitMessageDefault => {
    const value = form.get(name);
    return typeof value === "string" && COMMIT_MESSAGE_DEFAULTS.includes(value as CommitMessageDefault) ? (value as CommitMessageDefault) : fallback;
  };
  // A template is posted only while it is shown; otherwise the saved one stays.
  const template = (name: string, fallback: string | null) =>
    form.has(name) ? String(form.get(name) ?? "").trim() || null : fallback;
  const allowed = {
    allowMergeCommit: on("allowMergeCommit"),
    allowSquashMerge: on("allowSquashMerge"),
    allowRebaseMerge: on("allowRebaseMerge"),
    allowFastForward: on("allowFastForward"),
  };
  if (!Object.values(allowed).some(Boolean)) return { saved: false, error: "Allow at least one merge method." };
  const asked = form.get("defaultMergeMethod");
  const methods = allowedMethods(allowed);
  const settings = await work.updateSettings(user, path, {
    ...current.value,
    ...allowed,
    defaultMergeMethod: isMergeMethod(asked) && methods.includes(asked) ? asked : methods[0]!,
    mergeCommitMessage: choice("mergeCommitMessage", current.value.mergeCommitMessage),
    squashCommitMessage: choice("squashCommitMessage", current.value.squashCommitMessage),
    mergeCommitTemplate: template("mergeCommitTemplate", current.value.mergeCommitTemplate),
    squashCommitTemplate: template("squashCommitTemplate", current.value.squashCommitTemplate),
    suggestUpdatingBranches: on("suggestUpdatingBranches"),
    allowAutoMerge: on("allowAutoMerge"),
    autoMerge: on("autoMerge"),
    deleteBranchOnMerge: on("deleteBranchOnMerge"),
  });
  return settings.ok ? { saved: true, error: null } : { saved: false, error: settings.error.message };
}

export default function BranchSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { repo, settings, effective, noChecks, canPush, codeowners } = loaderData;
  const branch = repo.defaultBranch;
  const base = `/${repo.namespace}/${repo.name}`;
  const archived = Boolean(repo.archivedAt);
  const rules = isFailed(effective) ? null : effective;
  const active = rules?.rules.filter((rule) => rule.enforcement === "active") ?? [];
  const labels = [...new Set(active.map((rule) => ruleInfo(rule.type)?.label ?? rule.type))];
  return (
    <>
      <RepoSettingsHeading base={base} />
      {/* Its own form, so outside the settings one. */}
      {noChecks && (
        <div className="mb-8 max-w-4xl">
          <AddCiPrompt owner={repo.namespace} repo={repo.name} canAdd={canPush && !archived} />
        </div>
      )}
      <div className="max-w-4xl space-y-8">
        <Section
          title="Branch protection"
          about={`What holds for ${branch} and every other branch is set by rulesets, across the workspace.`}
        >
          <Link
            to={`${base}/settings/rules`}
            className="group flex items-start gap-3 rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-surface"
          >
            <Scale size={16} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0 grow">
              <span className="block text-sm font-medium">Rules for {branch}</span>
              {!isFailed(effective) && (
                <span className="mt-1 block text-sm text-muted">
                  {labels.length > 0 ? labels.join(" · ") : `No active rules hold for ${branch}: anyone who may push can change it.`}
                </span>
              )}
              {rules && rules.rulesets.length > 0 && (
                <span className="mt-2 flex flex-wrap gap-2">
                  {rules.rulesets.map((ruleset) => (
                    <span key={ruleset.id} className="inline-flex items-center gap-1.5 text-xs text-muted">
                      {ruleset.name} <EnforcementBadge enforcement={ruleset.enforcement} />
                    </span>
                  ))}
                </span>
              )}
            </span>
            <ChevronRight size={16} className="mt-0.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
          </Link>
          {isFailed(effective) && <Unavailable what={effective.what} compact />}
          <Link
            to={`${base}/settings/guardrails`}
            className="group flex items-center gap-3 rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-surface"
          >
            <ShieldCheck size={16} className="shrink-0 text-accent" />
            <span className="min-w-0 grow">
              <span className="block text-sm font-medium">Guardrails</span>
              <span className="mt-0.5 block text-sm text-muted">How long this repository's runs may take.</span>
            </span>
            <ChevronRight size={16} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
          </Link>
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

        <Form method="post">
          <fieldset disabled={archived} className="min-w-0 space-y-8">
            <Section
              id="merge-methods"
              title="Merge methods"
              about="How pull requests may land on their base branch. At least one stays on; a ruleset can narrow them for some branches."
            >
              <MergeMethodSettings settings={settings} disabled={archived} />
            </Section>

            <Section id="updating-branches" title="Updating branches" about="Bringing a pull request's branch up to date with its base.">
              <Toggle name="suggestUpdatingBranches" on={settings.suggestUpdatingBranches} title="Always suggest updating pull request branches">
                Whenever a pull request's base has commits its branch does not, offer to bring the branch up to date, with
                a merge commit or a rebase, even when nothing requires it. Off, the offer shows only when a rule requires
                pull requests to be up to date.
              </Toggle>
            </Section>

            <Section id="auto-merge" title="Auto-merge" about="Pull requests that merge on their own once everything they need is met.">
              <Toggle name="allowAutoMerge" on={settings.allowAutoMerge} title="Allow auto-merge">
                Whoever may merge a pull request can turn on auto-merge for it with the method and message they choose:
                it merges, as them, the moment its required reviews and checks pass.
              </Toggle>
              <Toggle name="autoMerge" on={settings.autoMerge} title="Land pull requests g1t sees through when ready">
                A pull request g1t is seeing through for a work item lands without anyone pressing merge once every rule of
                its branch is met, its required checks included. A ruleset can turn this off for some branches. Off, it
                waits for a member to merge it.
              </Toggle>
            </Section>

            <Section id="after-merging" title="After merging" about="What happens to a pull request's branch once it lands.">
              <Toggle name="deleteBranchOnMerge" on={settings.deleteBranchOnMerge} title="Automatically delete head branches">
                A pull request's branch is deleted once it merges. Whoever merges can keep it that time, and a deleted
                branch can be restored from its pull request.
              </Toggle>
            </Section>

            <div className="sticky bottom-(--tabbar-h) in-data-[keyboard=open]:bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
              <SubmitButton pending="Saving…" disabled={archived}>
                Save settings
              </SubmitButton>
              {actionData?.saved && <span className="text-sm text-muted">Saved.</span>}
              <ErrorText>{actionData?.error}</ErrorText>
              {settings.updatedBy && settings.updatedAt && !actionData && (
                <span className="text-xs text-faint">
                  Last changed by <span className="font-mono">{settings.updatedBy}</span> <TimeAgo at={settings.updatedAt} />
                </span>
              )}
            </div>
          </fieldset>
        </Form>
      </div>
    </>
  );
}
