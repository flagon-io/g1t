import { ChevronRight, Scale, ShieldCheck } from "lucide-react";
import { Suspense } from "react";
import { Await, Form, Link } from "react-router";

import { ruleInfo } from "../../lib/rules";

import type { Route } from "./+types/settings-branches";
import { page } from "../../lib/meta";
import { AddCiPrompt } from "../../components/add-ci";
import { CodeownersReportPanel, CodeownersReportSkeleton } from "../../components/codeowners";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { EnforcementBadge } from "../../components/rules";
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
  // Maintain and up: it shows the rules and changes only how agents work; to anyone without a role here the page does not exist.
  const { access } = await requireInsider(context, params, "manage_settings");
  const path = { namespace: params.owner, name: params.repo };
  const [repo, settings, seen, workflows] = await Promise.all([
    repos.get(path, viewer),
    work.getSettings(path, viewer),
    work.seenChecks(path, viewer),
    actions.workflows(path, viewer),
  ]);
  const found = unwrap(repo);
  // What holds for the default branch: shown here, changed in Rules.
  const effective = await work.effectiveRules(path, found.defaultBranch, viewer).catch(() => null);
  // Streamed: the CODEOWNERS file is read and checked on its own time.
  const codeowners = work
    .codeownersErrors(path, viewer)
    .then((report) => (report.ok ? report.value : null))
    .catch(() => null);
  return {
    codeowners,
    repo: found,
    settings: unwrap(settings),
    effective: effective?.ok ? effective.value : null,
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
  await requireCapability(context, params, "manage_settings");
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const on = (name: string) => form.get(name) === "on";
  // Branch protection is the repository's rulesets' (Settings → Rules):
  // what it holds is sent back as it is, so only how g1t's agents work
  // changes here.
  const current = await work.getSettings(path, user);
  if (!current.ok) return { saved: false, error: current.error.message };
  const settings = await work.updateSettings(user, path, {
    ...current.value,
    autoMerge: on("autoMerge"),
    agentReview: on("agentReview"),
    maxRevisions: count(form.get("maxRevisions"), 0, 5),
    holdLowConfidence: on("holdLowConfidence"),
  });
  return settings.ok ? { saved: true, error: null } : { saved: false, error: settings.error.message };
}

export default function BranchSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { repo, settings, effective, noChecks, canPush, codeowners } = loaderData;
  const branch = repo.defaultBranch;
  const base = `/${repo.namespace}/${repo.name}`;
  const archived = Boolean(repo.archivedAt);
  const active = effective?.rules.filter((rule) => rule.enforcement === "active") ?? [];
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
          about={`What holds for ${branch} and every other branch is set by rulesets: for people and agents alike, and across the workspace.`}
        >
          <Link
            to={`${base}/settings/rules`}
            className="group flex items-start gap-3 rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-surface"
          >
            <Scale size={16} className="mt-0.5 shrink-0 text-accent" />
            <span className="min-w-0 grow">
              <span className="block text-sm font-medium">Rules for {branch}</span>
              <span className="mt-1 block text-sm text-muted">
                {labels.length > 0 ? labels.join(" · ") : `No active rules hold for ${branch}: anyone who may push can change it.`}
              </span>
              {effective && effective.rulesets.length > 0 && (
                <span className="mt-2 flex flex-wrap gap-2">
                  {effective.rulesets.map((ruleset) => (
                    <span key={ruleset.id} className="inline-flex items-center gap-1.5 text-xs text-muted">
                      {ruleset.name} <EnforcementBadge enforcement={ruleset.enforcement} />
                    </span>
                  ))}
                </span>
              )}
            </span>
            <ChevronRight size={16} className="mt-0.5 shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
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
              title="g1t"
              about="What happens to a pull request g1t makes, from the moment it is ready. Its checks are the same workflows, and the branch's rules hold."
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
                A pull request g1t made lands without anyone pressing merge once every rule of its branch is met, its
                required checks included. A ruleset can turn this off for some branches, or ask for a confidence first
                (Agent auto-merge). With this off, it waits for a member. Pull requests from people and from other agents
                always wait.
              </Toggle>
              <Toggle
                name="holdLowConfidence"
                on={settings.holdLowConfidence}
                title="Ask a person before merging low-confidence changes"
              >
                g1t rates how sure it is of each change an agent finishes, from its required checks, revisions, review,
                tests, size and guardrails. One it rates low waits for a member to approve it, instead of merging by itself
                or joining the queue, and shows on Mission control as needing you. A Confidence threshold rule asks for
                more, branch by branch.
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
