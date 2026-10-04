import type { ReactNode } from "react";
import { Form, data, useNavigation } from "react-router";

import { RepoSettingsTabs } from "../../components/repo-settings-tabs";
import type { Route } from "./+types/settings-repository";
import { Button, ErrorText, Field, Input, TimeAgo } from "../../components/ui";
import { repos, work } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
  roleIn,
  unwrap,
} from "../../lib/session.server";

export function meta({ params }: Route.MetaArgs) {
  return [{ title: `Repository settings · ${params.owner}/${params.repo} · g1t` }];
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Members only; to anyone else the page does not exist.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const path = { namespace: params.owner, name: params.repo };
  const [repo, settings] = await Promise.all([
    repos.get(path, viewer),
    work.getSettings(path, viewer),
  ]);
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
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const on = (name: string) => form.get(name) === "on";

  // The repository's own details belong to one service and how its pull
  // requests are handled to another; the page is one form over both.
  const repo = await repos.update(user, path, {
    description: String(form.get("description") ?? ""),
    isPrivate: form.get("visibility") === "private",
    protected: on("protected"),
  });
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
  return settings.ok
    ? { saved: true, error: null }
    : { saved: false, error: settings.error.message };
}

function Section({
  title,
  about,
  children,
}: {
  title: string;
  about: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 border-t border-line pt-8 first:border-t-0 first:pt-0 lg:grid-cols-[16rem_1fr]">
      <div>
        <h2 className="font-medium">{title}</h2>
        <p className="mt-1 text-sm text-muted">{about}</p>
      </div>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

/** A setting that is on or off, with what it means. */
function Toggle({
  name,
  on,
  title,
  children,
}: {
  name: string;
  on: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-4 transition-colors hover:border-line-strong">
      <input type="checkbox" name={name} defaultChecked={on} className="mt-1 accent-accent" />
      <span>
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-1 block text-sm text-muted">{children}</span>
      </span>
    </label>
  );
}

/** A setting chosen from a few numbers. */
function Choice({
  name,
  value,
  options,
  title,
  children,
}: {
  name: string;
  value: number;
  options: [number, string][];
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-4 rounded-xl border border-line bg-surface p-4">
      <div className="grow">
        <p className="text-sm font-medium">{title}</p>
        <p className="mt-1 text-sm text-muted">{children}</p>
      </div>
      <select
        name={name}
        defaultValue={value}
        aria-label={title}
        className="shrink-0 rounded-md border border-line bg-bg px-2 py-1.5 text-sm"
      >
        {options.map(([option, label]) => (
          <option key={option} value={option}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

export default function RepoSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { repo, settings } = loaderData;
  const saving = useNavigation().state === "submitting";
  const branch = repo.defaultBranch;
  return (
    <>
      <RepoSettingsTabs base={`/${repo.namespace}/${repo.name}`} />
      <Form method="post" className="max-w-4xl space-y-8">
        <Section title="General" about="What the repository is and who can see it.">
          <Field label="Description">
            <Input name="description" maxLength={200} defaultValue={repo.description ?? ""} />
          </Field>
          <fieldset className="space-y-2 rounded-xl border border-line bg-surface p-4 text-sm">
            <legend className="sr-only">Visibility</legend>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="visibility"
                value="public"
                defaultChecked={!repo.isPrivate}
                className="mt-1 accent-accent"
              />
              <span>
                <span className="block font-medium">Public</span>
                <span className="text-muted">Anyone can see and clone it.</span>
              </span>
            </label>
            <label className="flex items-start gap-3">
              <input
                type="radio"
                name="visibility"
                value="private"
                defaultChecked={repo.isPrivate}
                className="mt-1 accent-accent"
              />
              <span>
                <span className="block font-medium">Private</span>
                <span className="text-muted">Only members of the workspace can see it.</span>
              </span>
            </label>
          </fieldset>
        </Section>

        <Section
          title="Branch protection"
          about={`Rules for ${branch}, the branch everything lands on.`}
        >
          <Toggle
            name="protected"
            on={repo.protected}
            title={`Require a pull request to change ${branch}`}
          >
            Pushing to {branch} is refused, for members and agents alike, and git says why.
            Changes reach it only by merging a pull request. The first push to an empty
            repository is still allowed.
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
            How many reviewers must approve before a pull request can merge. A reviewer
            who has since asked for changes blocks it, and nobody approves their own.
          </Choice>
          <Toggle
            name="countAgentApprovals"
            on={settings.countAgentApprovals}
            title="A g1t agent's approval counts"
          >
            With this off, required approvals have to come from people, and an agent's
            review is advice.
          </Toggle>
          <Toggle
            name="requireChecks"
            on={!settings.allowIgnoringChecks}
            title="Require acceptance checks to pass"
          >
            With this off, a member can choose to merge although the issue's checks
            failed or have not finished. With it on, nobody can.
          </Toggle>
          <Toggle
            name="requireUpToDate"
            on={settings.requireUpToDate}
            title="Require pull requests to be up to date before merging"
          >
            With this off, a pull request can be merged after {branch} has moved: g1t
            brings it up to date as part of merging, and asks you only if there is a
            conflict it cannot resolve. With it on, it has to catch up first and its
            checks run again on the result, so what lands is exactly what was checked.
          </Toggle>
          <Toggle name="mergeQueue" on={settings.mergeQueue} title="Merge through a queue">
            Merging adds a pull request to the queue instead of changing {branch} at once.
            g1t tests it together with every pull request ahead of it, several
            combinations at a time, and {branch} only ever moves to a combination whose
            checks passed. One that fails leaves the queue and goes back to its author,
            and the ones behind it are tested again without it.
          </Toggle>
        </Section>

        <Section
          title="g1t agents"
          about="What happens to a pull request a g1t agent makes, from the moment it is ready."
        >
          <Toggle name="agentReview" on={settings.agentReview} title="Review by a second agent">
            A different agent reads each change and posts comments on lines, a summary
            and a verdict. If it asks for changes, the author is sent back to make them.
            With this off, review is left to people.
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
            How many times an agent is sent back to fix failed checks or address a
            review before g1t stops and the pull request says it needs you.
          </Choice>
          <Toggle name="autoMerge" on={settings.autoMerge} title="Merge automatically when ready">
            A g1t agent's pull request lands without anyone pressing merge once every
            rule above is met. With this off, it waits for a member. Pull requests from
            people and from other agents always wait.
          </Toggle>
        </Section>

        <div className="sticky bottom-0 -mx-4 flex flex-wrap items-center gap-4 border-t border-line bg-bg/90 px-4 py-4 backdrop-blur">
          <Button type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save settings"}
          </Button>
          {actionData?.saved && <span className="text-sm text-muted">Saved.</span>}
          <ErrorText>{actionData?.error}</ErrorText>
          {settings.updatedBy && settings.updatedAt && !actionData && (
            <span className="text-xs text-faint">
              Merge rules last changed by{" "}
              <span className="font-mono">{settings.updatedBy}</span>{" "}
              <TimeAgo at={settings.updatedAt} />
            </span>
          )}
        </div>
      </Form>
    </>
  );
}
