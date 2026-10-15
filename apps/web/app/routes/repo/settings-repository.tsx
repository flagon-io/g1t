import { ChevronRight, GitBranch } from "lucide-react";
import { useState } from "react";
import { Form, Link, redirect, useNavigation } from "react-router";

import { type Result, needs } from "@g1t/contracts";

import { DangerAction, DangerZone } from "../../components/danger-zone";
import { ConfirmDialog } from "../../components/repo-lifecycle";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { SettingsSection as Section, SettingToggle } from "../../components/settings-section";
import { SwitchCard } from "../../components/ui/switch";
import type { Route } from "./+types/settings-repository";
import { page } from "../../lib/meta";
import { confirmsName, tidyName } from "../../lib/repo-lifecycle";
import { ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { Button } from "../../components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Card } from "../../components/ui/card";
import { FieldLabel, Field as FormField } from "../../components/ui/field";
import { Input as TextInput } from "../../components/ui/input";
import { actions, repos, work } from "../../lib/services.server";
import {
  assertSameOrigin,
  getViewer,
  requireUser,
} from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { Unavailable } from "../../components/boundary";
import { isFailed, part } from "../../lib/partial";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Repository settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up; to anyone without a role here the page does not exist.
  const { repo, access } = await requireInsider(context, params, "manage_settings");
  const path = { namespace: params.owner, name: params.repo };
  // Each of these is one section's: when one cannot be read, that section
  // says so and has no form to save over what it could not show.
  const [branches, retention, settings] = await Promise.all([
    part(repos.branches(path, viewer), "Its branches"),
    part(actions.artifactRetention(path, viewer), "How long artifacts are kept"),
    part(work.getSettings(path, viewer), "These settings"),
  ]);
  // Renaming and the default branch are for Admins; visibility, for owners
  // of the workspace unless its member privileges let its members with
  // Admin. Archiving, moving and deleting are the project's, on General.
  const owner = access.can.administer;
  return {
    repo,
    // An empty repository has no branches yet; the page still works.
    branches: isFailed(branches) ? branches : branches.ok ? branches.value.map((b) => b.name) : [],
    owner,
    visibility: access.can.change_visibility,
    // How long workflow runs' artifacts are kept.
    retention: isFailed(retention) ? retention : retention.ok ? retention.value : { days: 14, maximum_allowed_days: 90 },
    // Whether issues can be opened in it; null when it was not answered.
    issues: isFailed(settings)
      ? settings
      : settings.ok
        ? { on: settings.value.issuesEnabled ?? true, chosen: settings.value.hasIssues != null }
        : null,
    // How commits and issues are handled; null when it was not answered.
    pullSettings: isFailed(settings)
      ? settings
      : settings.ok
        ? {
            autoCloseIssues: settings.value.autoCloseIssues,
            requireWebCommitSignOff: settings.value.requireWebCommitSignOff,
            allowCommitComments: settings.value.allowCommitComments,
          }
        : null,
  };
}

/** What a form on this page came back with: which one, and how it went. */
type Outcome = { intent: string; saved: boolean; error: string | null };

function outcome(intent: string, result: Result<unknown>): Outcome {
  return result.ok ? { intent, saved: true, error: null } : { intent, saved: false, error: result.error.message };
}

export async function action({ request, params, context }: Route.ActionArgs): Promise<Outcome> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const path = { namespace: params.owner, name: params.repo };
  const full = `${params.owner}/${params.repo}`;
  const intent = String(form.get("intent") ?? "details");
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const typed = text("confirm");
  // What each form needs: the details are settings, renaming a branch other
  // than the default is pushing.
  const capability =
    intent === "details" || intent === "artifacts" || intent === "features" || intent === "commits"
      ? "manage_settings"
      : intent === "rename-branch"
        ? "push"
        : "administer";
  const refused = await refusal(context, params, capability);
  if (refused) return { intent, saved: false, error: refused };

  switch (intent) {
    case "rename": {
      const renamed = await repos.rename(user, path, tidyName(text("name")));
      if (!renamed.ok) return outcome(intent, renamed);
      // The old address redirects, but the page moves with it now.
      throw redirect(`/${renamed.value.namespace}/${renamed.value.name}/settings/repository`);
    }
    case "default-branch":
      return outcome(intent, await repos.setDefaultBranch(user, path, text("branch")));
    case "rename-branch":
      return outcome(intent, await repos.renameBranch(user, path, text("from"), text("to")));
    case "visibility": {
      if (!confirmsName(typed, full)) return { intent, saved: false, error: `Type ${full} to confirm.` };
      return outcome(intent, await repos.setVisibility(user, path, text("visibility") === "private", typed));
    }
    case "features": {
      // The other settings are sent back as they are: only issues change here.
      const current = await work.getSettings(path, user);
      if (!current.ok) return outcome(intent, current);
      return outcome(
        intent,
        await work.updateSettings(user, path, {
          ...current.value,
          hasIssues: form.get("hasIssues") === "on",
          autoCloseIssues: form.get("autoCloseIssues") === "on",
        }),
      );
    }
    case "commits": {
      // The other settings are sent back as they are.
      const current = await work.getSettings(path, user);
      if (!current.ok) return outcome(intent, current);
      return outcome(
        intent,
        await work.updateSettings(user, path, {
          ...current.value,
          requireWebCommitSignOff: form.get("requireWebCommitSignOff") === "on",
          allowCommitComments: form.get("allowCommitComments") === "on",
        }),
      );
    }
    case "pushes": {
      // Off is 0: no limit.
      const limit = form.get("limitRefUpdates") === "on" ? Math.trunc(Number(text("maxRefUpdates"))) : 0;
      if (!Number.isFinite(limit) || limit < 0 || limit > 1000 || (form.get("limitRefUpdates") === "on" && limit < 1)) {
        return { intent, saved: false, error: "Enter a number of branches and tags from 1 to 1000." };
      }
      return outcome(intent, await repos.update(user, path, { maxRefUpdates: limit }));
    }
    case "forking":
      return outcome(intent, await repos.update(user, path, { allowForking: form.get("allowForking") === "on" }));
    case "detach":
      return outcome(intent, await repos.detachFork(user, path));
    case "artifacts":
      return outcome(intent, await actions.artifactRetention(path, user, Number(text("days"))));
    default:
      return outcome(
        "details",
        await repos.update(user, path, {
          website: text("website"),
          // Typed with commas or spaces between them; the service tidies the rest.
          topics: text("topics").split(/[\s,]+/).filter(Boolean),
        }),
      );
  }
}

/** Saved, or the error, for the form that posted `intent`. */
function Status({ intent, data: result, saved = "Saved." }: { intent: string; data: Outcome | undefined; saved?: string }) {
  if (result?.intent !== intent) return null;
  return result.saved ? <span className="text-sm text-muted">{saved}</span> : <ErrorText>{result.error}</ErrorText>;
}

export default function RepoSettings({ loaderData, actionData }: Route.ComponentProps) {
  const { repo, branches, owner, visibility, retention, issues: features, pullSettings: commits } = loaderData;
  // Settings that could not be read are said to be, in their sections.
  const issues = isFailed(features) ? null : features;
  const pullSettings = isFailed(commits) ? null : commits;
  const navigation = useNavigation();
  const posting = (intent: string) => navigation.state !== "idle" && navigation.formData?.get("intent") === intent;
  const base = `/${repo.namespace}/${repo.name}`;
  const full = `${repo.namespace}/${repo.name}`;
  const archived = Boolean(repo.archivedAt);
  const errorFor = (intent: string) => (actionData?.intent === intent ? actionData.error : null);
  return (
    <>
      <RepoSettingsHeading base={base} />
      <div className="max-w-4xl space-y-8">
        <Section title="Name" about="Its address on g1t, in git remotes and in the API.">
          <RenameForm repo={repo} owner={owner} archived={archived} busy={posting("rename")} result={actionData} />
        </Section>

        <Section
          title="Details"
          about={
            <>
              Its website and topics, for its page, search and Explore. Its description is its project's, on{" "}
              <Link to={`${base}/settings`} className="text-accent hover:underline">
                General
              </Link>
              .
            </>
          }
        >
          {/* Keyed to what is saved, so the fields show the topics as the service tidied them. */}
          <Form method="post" key={`${repo.website ?? ""}|${(repo.topics ?? []).join(",")}`}>
            <fieldset disabled={archived} className="min-w-0 space-y-3 disabled:cursor-not-allowed disabled:opacity-60">
              <input type="hidden" name="intent" value="details" />
              <Field label="Website" hint="Its home page, shown on its page. An http or https address.">
                <Input name="website" type="url" maxLength={300} defaultValue={repo.website ?? ""} placeholder="https://" />
              </Field>
              <Field
                label="Topics"
                hint="What it is about, for search and Explore: words such as cli, rust or design-system, separated by commas or spaces. Up to 20."
              >
                <Input name="topics" maxLength={800} defaultValue={(repo.topics ?? []).join(", ")} placeholder="cli, rust" />
              </Field>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <SubmitButton match={{ intent: "details" }} pending="Saving…">
                  Save
                </SubmitButton>
                <Status intent="details" data={actionData} />
              </div>
            </fieldset>
          </Form>
        </Section>

        <Section
          title="Branches"
          about="The branch everything lands on, and renaming branches."
        >
          {isFailed(branches) ? (
            <Unavailable what={branches.what} />
          ) : (
            <>
              <DefaultBranchForm repo={repo} branches={branches} archived={archived || !owner} busy={posting("default-branch")} result={actionData} />
              {/* Keyed to the branches, so after a rename it starts over on the branches there are now. */}
              <RenameBranchForm
                key={branches.join(" ")}
                repo={repo}
                branches={branches}
                owner={owner}
                archived={archived}
                busy={posting("rename-branch")}
                result={actionData}
              />
            </>
          )}
          <Link
            to={`${base}/settings/branches`}
            className="group flex items-center gap-3 rounded-xl border border-line p-4 transition-colors hover:border-line-strong hover:bg-surface"
          >
            <GitBranch size={16} className="shrink-0 text-accent" />
            <span className="min-w-0 grow">
              <span className="block text-sm font-medium">Branches and merging</span>
              <span className="mt-0.5 block text-sm text-muted">
                Merge methods and commit messages, auto-merge, deleting branches after merging, and the rules for{" "}
                {repo.defaultBranch}.
              </span>
            </span>
            <ChevronRight size={16} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" />
          </Link>
        </Section>

        {isFailed(features) && (
          <Section title="Features" about="What the repository has besides its code.">
            <Unavailable what="Its features" />
          </Section>
        )}
        {issues && (
          <Section title="Features" about="What the repository has besides its code.">
            <Form method="post" key={`${issues.on}|${pullSettings?.autoCloseIssues}`} className="space-y-3">
              <fieldset disabled={archived} className="min-w-0 space-y-3">
                <input type="hidden" name="intent" value="features" />
                <SettingToggle name="hasIssues" on={issues.on} title="Issues" disabled={archived}>
                  Track bugs, ideas and work to do in it. Turned off, no new issue can be opened and Issues leaves its
                  menus; issues already opened stay readable at their addresses.
                  {repo.forkedFrom && !issues.chosen && " Off by default, as it was made as a fork."}
                </SettingToggle>
                {pullSettings && (
                  <SettingToggle
                    name="autoCloseIssues"
                    on={pullSettings.autoCloseIssues}
                    title="Auto-close issues with merged linked pull requests"
                    disabled={archived}
                  >
                    When a pull request merges into {repo.defaultBranch}, the issues it is for or names after a closing
                    keyword (<span className="font-mono text-xs">Fixes #12</span>,{" "}
                    <span className="font-mono text-xs">Closes #12</span>) close, naming it. Off, they stay open to be
                    closed by hand.
                  </SettingToggle>
                )}
                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <SubmitButton variant="outline" match={{ intent: "features" }} pending="Saving…">
                    Save
                  </SubmitButton>
                  <Status intent="features" data={actionData} />
                </div>
              </fieldset>
            </Form>
          </Section>
        )}

        {isFailed(commits) && (
          <Section id="commits" title="Commits" about="Commits made on g1t, and talking about commits.">
            <Unavailable what="Its commit settings" />
          </Section>
        )}
        {pullSettings && (
          <Section id="commits" title="Commits" about="Commits made on g1t, and talking about commits.">
            <Form method="post" key={`${pullSettings.requireWebCommitSignOff}|${pullSettings.allowCommitComments}`} className="space-y-3">
              <fieldset disabled={archived} className="min-w-0 space-y-3">
                <input type="hidden" name="intent" value="commits" />
                <SettingToggle
                  name="requireWebCommitSignOff"
                  on={pullSettings.requireWebCommitSignOff}
                  title="Require contributors to sign off on web-based commits"
                  disabled={archived}
                >
                  Every commit made on g1t.sh, from editing a file to merging a pull request, carries a{" "}
                  <span className="font-mono text-xs">Signed-off-by:</span> line for whoever made it: their statement
                  that they may contribute it under the project's license, as the{" "}
                  <a
                    href="https://developercertificate.org/"
                    target="_blank"
                    rel="noreferrer"
                    className="text-fg underline underline-offset-2 hover:text-accent"
                    onClick={(event) => event.stopPropagation()}
                  >
                    Developer Certificate of Origin
                  </a>{" "}
                  asks.
                </SettingToggle>
                <SettingToggle
                  name="allowCommitComments"
                  on={pullSettings.allowCommitComments}
                  title="Allow comments on individual commits"
                  disabled={archived}
                >
                  Anyone who can read it may comment on a commit, or on one line of a file a commit changed, from the
                  commit's page. Off, comments already made stay readable and no new ones can be added.
                </SettingToggle>
                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <SubmitButton variant="outline" match={{ intent: "commits" }} pending="Saving…">
                    Save
                  </SubmitButton>
                  <Status intent="commits" data={actionData} />
                </div>
              </fieldset>
            </Form>
          </Section>
        )}

        <Section id="pushes" title="Pushes" about="What a single push may change.">
          <PushLimitForm limit={repo.maxRefUpdates ?? 0} disabled={archived || !owner} owner={owner} result={actionData} />
        </Section>

        <Section id="archives" title="Archives" about="What the .zip and .tar.gz downloads of its code hold.">
          {/* Large file storage is not built yet: shown so the choice has its place. */}
          <SwitchCard
            name="includeLfsInArchives"
            defaultChecked={false}
            disabled
            title="Include Git LFS objects in archives"
          >
            <Badge tone="neutral" size="sm" className="mr-1.5 align-middle">
              Coming soon
            </Badge>
            Archives would hold the files Git LFS stores, not only their pointers. g1t does not store Git LFS files yet.
          </SwitchCard>
        </Section>

        <Section title="Artifacts" about="How long the files workflow runs upload are kept.">
          {isFailed(retention) ? (
            <Unavailable what={retention.what} />
          ) : (
            <Form method="post" key={retention.days} className="space-y-3">
              <input type="hidden" name="intent" value="artifacts" />
              <Field
                label="Days to keep artifacts"
                hint={`1 to ${retention.maximum_allowed_days}. A workflow's retention-days can ask for fewer, never more. Artifacts already uploaded keep their expiry.`}
              >
                <Input
                  name="days"
                  type="number"
                  min={1}
                  max={retention.maximum_allowed_days}
                  required
                  defaultValue={retention.days}
                  className="w-28"
                />
              </Field>
              <div className="flex flex-wrap items-center gap-4 pt-1">
                <SubmitButton match={{ intent: "artifacts" }} pending="Saving…">
                  Save
                </SubmitButton>
                <Status intent="artifacts" data={actionData} />
              </div>
            </Form>
          )}
        </Section>

        {repo.isPrivate && (
          <Section id="forking" title="Forking" about="Whether people who can read it may copy it into their own workspaces.">
            <Form method="post" key={String(Boolean(repo.allowForking))} className="space-y-3">
              <fieldset disabled={!owner || archived} className="min-w-0 space-y-3">
                <input type="hidden" name="intent" value="forking" />
                <SettingToggle name="allowForking" on={Boolean(repo.allowForking)} title="Allow forking" disabled={!owner || archived}>
                  People who can read it may fork it into their own workspaces. Forks stay private.
                </SettingToggle>
                <div className="flex flex-wrap items-center gap-4 pt-1">
                  <SubmitButton variant="outline" match={{ intent: "forking" }} pending="Saving…">
                    Save
                  </SubmitButton>
                  <Status intent="forking" data={actionData} />
                  {!owner && <span className="text-xs text-faint">{needs("administer")}</span>}
                </div>
              </fieldset>
            </Form>
          </Section>
        )}

        {owner && (visibility || repo.parentId) ? (
          <div id="danger-zone" className="scroll-mt-20 border-t border-line pt-8">
            <DangerZone>
              {visibility && <VisibilityAction full={full} isPrivate={repo.isPrivate} fork={Boolean(repo.parentId)} error={errorFor("visibility")} />}
              {repo.parentId && <DetachAction full={full} parent={repo.parent ?? null} error={errorFor("detach")} />}
            </DangerZone>
            <LifecycleNote base={base} />
          </div>
        ) : (
          <div className="border-t border-line pt-8 text-sm text-muted">
            {owner ? (
              <p>Only an owner of the workspace can change who can see it: its member privileges keep that to owners.</p>
            ) : (
              <p>
                Renaming it needs the Admin role, and changing who can see it an owner of the workspace, unless its member
                privileges let repository admins.
              </p>
            )}
            <LifecycleNote base={base} />
          </div>
        )}
      </div>
    </>
  );
}

/** Where archiving, transferring and deleting went: they are the project's. */
function LifecycleNote({ base }: { base: string }) {
  return (
    <p className="mt-4 text-sm text-muted">
      Archiving, transferring and deleting it are the project's, at the end of{" "}
      <Link to={`${base}/settings#danger-zone`} className="text-accent hover:underline">
        General
      </Link>
      .
    </p>
  );
}

/** The most branches and tags one push may update: off (0), or a number. */
function PushLimitForm({
  limit,
  disabled,
  owner,
  result,
}: {
  limit: number;
  disabled: boolean;
  owner: boolean;
  result: Outcome | undefined;
}) {
  const [on, setOn] = useState(limit > 0);
  return (
    <Form method="post" key={limit} className="space-y-3">
      <fieldset disabled={disabled} className="min-w-0 space-y-3">
        <input type="hidden" name="intent" value="pushes" />
        <SwitchCard
          name="limitRefUpdates"
          checked={on}
          onCheckedChange={setOn}
          disabled={disabled}
          title="Limit how many branches and tags can be updated in a single push"
        >
          A push that creates, moves or deletes more than this many branches and tags at once is refused whole, so a
          mistaken <span className="font-mono text-xs">git push --mirror</span> or{" "}
          <span className="font-mono text-xs">--all</span> cannot rewrite the repository.
        </SwitchCard>
        {on && (
          <FormField className="pl-4">
            <FieldLabel htmlFor="max-ref-updates">Most branches and tags per push</FieldLabel>
            <TextInput
              id="max-ref-updates"
              name="maxRefUpdates"
              type="number"
              min={1}
              max={1000}
              required
              defaultValue={limit > 0 ? limit : 5}
              className="w-28"
            />
          </FormField>
        )}
        <div className="flex flex-wrap items-center gap-4 pt-1">
          <SubmitButton variant="outline" match={{ intent: "pushes" }} pending="Saving…">
            Save
          </SubmitButton>
          <Status intent="pushes" data={result} />
          {!owner && <span className="text-xs text-faint">{needs("administer")}</span>}
        </div>
      </fieldset>
    </Form>
  );
}

type RepoLike = { namespace: string; name: string; defaultBranch: string; isPrivate: boolean };

/** The repository's name, which owners can change; its old address keeps redirecting. */
function RenameForm({
  repo,
  owner,
  archived,
  busy,
  result,
}: {
  repo: RepoLike;
  owner: boolean;
  archived: boolean;
  busy: boolean;
  result: Outcome | undefined;
}) {
  const [name, setName] = useState(repo.name);
  const wanted = tidyName(name);
  const changed = wanted !== "" && wanted !== repo.name;
  return (
    <Form method="post">
      <fieldset disabled={!owner || archived} className="min-w-0 space-y-3">
        <input type="hidden" name="intent" value="rename" />
        <FormField>
          <FieldLabel htmlFor="repo-name" className="sr-only">Name</FieldLabel>
          <div className="flex flex-col gap-3 sm:flex-row">
            <TextInput
              id="repo-name"
              name="name"
              value={name}
              maxLength={100}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
              className="font-mono"
            />
            <Button type="submit" variant="outline" disabled={!changed || busy}>
              {busy ? "Renaming…" : "Rename"}
            </Button>
          </div>
        </FormField>
        <p className="text-xs text-faint">
          {!owner ? (
            needs("administer")
          ) : changed ? (
            <>
              It moves to <span className="font-mono break-all text-fg">g1t.sh/{repo.namespace}/{wanted}</span>. Links, git
              remotes and API calls to <span className="font-mono break-all">g1t.sh/{repo.namespace}/{repo.name}</span>{" "}
              redirect there until a repository is made at the old address.
            </>
          ) : (
            <>
              At <span className="font-mono break-all">g1t.sh/{repo.namespace}/{repo.name}</span>. After a rename, the old
              address redirects to the new one.
            </>
          )}
        </p>
        <Status intent="rename" data={result} />
      </fieldset>
    </Form>
  );
}

/** Which branch is the default: what pull requests open against and protection covers. */
function DefaultBranchForm({
  repo,
  branches,
  archived,
  busy,
  result,
}: {
  repo: RepoLike;
  branches: string[];
  archived: boolean;
  busy: boolean;
  result: Outcome | undefined;
}) {
  const [branch, setBranch] = useState(repo.defaultBranch);
  const options = branches.includes(repo.defaultBranch) ? branches : [repo.defaultBranch, ...branches];
  return (
    <Card asChild className="p-4">
      <Form method="post">
        <fieldset disabled={archived} className="min-w-0">
          <input type="hidden" name="intent" value="default-branch" />
          <p className="text-sm font-medium">Default branch</p>
          <p className="mt-1 text-sm text-muted">
            What the repository opens on, what pull requests target, and what branch protection covers.
          </p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <Select name="branch" value={branch} onValueChange={setBranch} disabled={archived || options.length < 2}>
              <SelectTrigger aria-label="Default branch" className="font-mono sm:max-w-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {options.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button type="submit" variant="outline" disabled={busy || branch === repo.defaultBranch}>
              {busy ? "Changing…" : "Change default branch"}
            </Button>
          </div>
          {options.length < 2 && (
            <p className="mt-2 text-xs text-faint">Push another branch to make it the default instead.</p>
          )}
          <div className="mt-2">
            <Status intent="default-branch" data={result} />
          </div>
        </fieldset>
      </Form>
    </Card>
  );
}

/** Renaming a branch: pull requests from it follow, and old addresses redirect. */
function RenameBranchForm({
  repo,
  branches,
  owner,
  archived,
  busy,
  result,
}: {
  repo: RepoLike;
  branches: string[];
  owner: boolean;
  archived: boolean;
  busy: boolean;
  result: Outcome | undefined;
}) {
  // Only Admins rename the default branch.
  const renamable = owner ? branches : branches.filter((b) => b !== repo.defaultBranch);
  const [from, setFrom] = useState(renamable[0] ?? "");
  const [to, setTo] = useState("");
  const ready = from !== "" && to.trim() !== "" && to.trim() !== from;
  return (
    <Card asChild className="p-4">
      <Form method="post" onSubmit={() => setTo(to.trim())}>
        <fieldset disabled={archived || renamable.length === 0} className="min-w-0">
          <input type="hidden" name="intent" value="rename-branch" />
          <p className="text-sm font-medium">Rename a branch</p>
          <p className="mt-1 text-sm text-muted">
            Pull requests from it follow it, and addresses that name the old branch redirect to the new one.
            {owner ? "" : ` Renaming ${repo.defaultBranch} needs the Admin role.`}
          </p>
          {renamable.length === 0 ? (
            <p className="mt-3 text-sm text-faint">There is no branch you can rename yet.</p>
          ) : (
            <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
              <FormField>
                <FieldLabel htmlFor="rename-from">Branch</FieldLabel>
                <Select name="from" value={from} onValueChange={setFrom}>
                  <SelectTrigger id="rename-from" aria-label="Branch" className="font-mono">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {renamable.map((name) => (
                      <SelectItem key={name} value={name} className="font-mono">
                        {name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </FormField>
              <FormField>
                <FieldLabel htmlFor="rename-to">New name</FieldLabel>
                <TextInput
                  id="rename-to"
                  name="to"
                  value={to}
                  maxLength={200}
                  spellCheck={false}
                  autoCapitalize="off"
                  autoComplete="off"
                  placeholder={from === repo.defaultBranch ? "main" : "feature/new-name"}
                  onChange={(event) => setTo(event.target.value)}
                  className="font-mono"
                />
              </FormField>
              <Button type="submit" variant="outline" disabled={!ready || busy}>
                {busy ? "Renaming…" : "Rename branch"}
              </Button>
            </div>
          )}
          <div className="mt-2">
            <Status intent="rename-branch" data={result} saved="Renamed." />
          </div>
        </fieldset>
      </Form>
    </Card>
  );
}

/** Public to private or back, with what changes, typed out to confirm. */
function VisibilityAction({ full, isPrivate, fork, error }: { full: string; isPrivate: boolean; fork: boolean; error: string | null }) {
  const next = isPrivate ? "public" : "private";
  if (fork) {
    return (
      <DangerAction
        title="Change visibility"
        action={
          <Button type="button" variant="destructive" disabled>
            Make {next}
          </Button>
        }
      >
        It is {isPrivate ? "private" : "public"}. A fork is as visible as the repository it came from. Detach it to change this.
      </DangerAction>
    );
  }
  return (
    <ConfirmDialog
      intent="visibility"
      fields={{ visibility: next }}
      title={`Make ${full} ${next}?`}
      confirm={full}
      submit={`Make ${next}`}
      busy="Changing…"
      error={error}
      trigger={(open) => (
        <DangerAction
          title="Change visibility"
          action={
            <Button type="button" variant="destructive" onClick={open}>
              Make {next}
            </Button>
          }
        >
          It is {isPrivate ? "private: only people with access can see it" : "public: anyone can see and clone it"}.
        </DangerAction>
      )}
    >
      {isPrivate ? (
        <>
          <li>Anyone can see its code, issues and pull requests, and clone it, without signing in.</li>
          <li>It shows in search and on Explore.</li>
          <li>Links to it show a preview card with its name and its project's description where they are shared.</li>
        </>
      ) : (
        <>
          <li>Only people with access can see it: owners, members by the workspace's base permission, and people you add. Anyone else gets a page that says it does not exist.</li>
          <li>It leaves search and Explore, and links to it stop showing a preview card.</li>
          <li>Its storage counts toward the workspace's private storage. A free workspace has 1 GB, and making it private is refused when that would go over.</li>
        </>
      )}
    </ConfirmDialog>
  );
}

/** A fork made an ordinary repository, with no parent. */
function DetachAction({
  full,
  parent,
  error,
}: {
  full: string;
  parent: { namespace: string; name: string } | null;
  error: string | null;
}) {
  const from = parent ? `${parent.namespace}/${parent.name}` : "the repository it came from";
  return (
    <ConfirmDialog
      intent="detach"
      title={`Detach ${full} from ${from}?`}
      description="It becomes an ordinary repository. This can't be undone."
      confirm={full}
      submit="Detach fork"
      busy="Detaching…"
      error={error}
      trigger={(open) => (
        <DangerAction
          title="Detach fork"
          action={
            <Button type="button" variant="destructive" onClick={open}>
              Detach
            </Button>
          }
        >
          It is a fork of <span className="font-mono text-fg/85">{from}</span>. Detaching makes it a repository of its own.
        </DangerAction>
      )}
    >
      <li>Sync fork stops: it no longer brings in what lands on {from}.</li>
      <li>Opening pull requests from it to {from} is no longer offered.</li>
      <li>It stops showing among {from}'s forks, and its page no longer says where it came from.</li>
      <li>Its visibility can then be changed on its own.</li>
      <li>It can't be attached again.</li>
    </ConfirmDialog>
  );
}
