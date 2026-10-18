import { Box, GitBranch, GitFork } from "lucide-react";
import { Form, redirect, useNavigate } from "react-router";

import type { Route } from "./+types/pull-new";
import { page } from "../../lib/meta";
import { cloneUrl, useAddresses } from "../../lib/addresses";
import { Combobox } from "../../components/ui/combobox";
import { Hint } from "../../components/ui/hint";
import {
  SubmitButton,
  CopyLine,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Textarea,
} from "../../components/ui";
import { Card } from "../../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { accessFor } from "../../lib/access.server";
import { repos, work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";
import { Unavailable } from "../../components/boundary";
import { type Failed, isFailed, part } from "../../lib/partial";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New pull request · ${params.owner}/${params.repo} · g1t` });
}

/**
 * `?head=` names where the change is: a branch of this repository
 * (`branch`), or a branch of a fork of it (`namespace/name:branch`, or
 * `namespace/name:` for its branches), as a fork's Contribute link asks.
 */
function parseHead(head: string): { repo: string | null; branch: string } {
  const colon = head.indexOf(":");
  if (colon < 0) return { repo: null, branch: head };
  return { repo: head.slice(0, colon).toLowerCase() || null, branch: head.slice(colon + 1) };
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const path = { namespace: params.owner, name: params.repo };
  const query = new URL(request.url).searchParams;
  const head = parseHead(query.get("head") ?? "");
  // The repository and its branches are the form. The rest are parts of it:
  // the open pull requests only take branches that have one off the list
  // (opening another is refused anyway), and the forks say so when they fail.
  const [repo, branches, open, forks] = await Promise.all([
    repos.get(path, user),
    repos.branches(path, user),
    part(work.listPulls(path, user, "open"), "Open pull requests"),
    // Forks of it the viewer can push to: pull requests can come from their branches.
    part(repos.forks(path, user, 100).then((found) => (found.ok ? found.value : [])), "Your forks"),
  ]);
  const { defaultBranch } = unwrap(repo);
  const all = unwrap(branches).filter((branch) => !branch.name.startsWith("g1t-queue/"));
  const theirs = isFailed(forks) ? [] : forks.filter((fork) => accessFor(user, fork).can.push);
  const self = `${params.owner}/${params.repo}`.toLowerCase();
  // From a fork when one of theirs is asked for; this repository otherwise.
  // One asked for by name is read itself, so an older fork, or a fork of a
  // fork, is found too; opening the pull request checks it is one of this.
  const listed = head.repo && head.repo !== self ? (theirs.find((f) => `${f.namespace}/${f.name}`.toLowerCase() === head.repo) ?? null) : null;
  const [askedNamespace, askedName] = (head.repo ?? "").split("/");
  const lookedUp =
    listed == null && head.repo && head.repo !== self && askedNamespace && askedName
      ? await part(
          repos
            .get({ namespace: askedNamespace, name: askedName }, user)
            .then((found) => (found.ok && found.value.parentId && accessFor(user, found.value).can.push ? found.value : null)),
          "The fork",
        )
      : null;
  const fork = listed ?? (isFailed(lookedUp) ? null : lookedUp);
  if (fork && !theirs.some((f) => f.id === fork.id)) theirs.unshift(fork);
  const headRepo = fork ? { namespace: fork.namespace, name: fork.name } : null;
  const headFound = headRepo
    ? await part(repos.branches(headRepo, user).then((found) => (found.ok ? found.value : [])), "The fork's branches")
    : all;
  // A fork asked for whose branches could not be read: the form says so,
  // rather than offering this repository's branches or none.
  const headFailed: Failed | null = isFailed(lookedUp) ? lookedUp : isFailed(headFound) ? headFound : null;
  const headBranches = isFailed(headFound) ? [] : headFound;
  // Into the default branch unless another is asked for (Compare's base).
  const asked = query.get("base") ?? "";
  const base = all.some((branch) => branch.name === asked) ? asked : defaultBranch;
  const baseHead = all.find((branch) => branch.name === base)?.hash;
  // A branch that already has an open pull request into this base cannot
  // have another: from the same repository, this one or the fork.
  const key = (p: { namespace: string; name: string } | null | undefined) => (p ? `${p.namespace}/${p.name}`.toLowerCase() : "");
  const taken = new Set(
    !isFailed(open) && open.ok
      ? open.value.filter((pull) => (pull.base ?? defaultBranch) === base && key(pull.headRepo) === key(headRepo)).map((pull) => pull.branch)
      : [],
  );
  return {
    defaultBranch,
    base,
    bases: all.map((branch) => branch.name),
    branches: headBranches
      .filter((branch) => !branch.name.startsWith("g1t-queue/"))
      // A branch at the same commit as the base has nothing to merge.
      .filter((branch) => (headRepo || branch.name !== base) && branch.hash !== baseHead)
      .map((branch) => branch.name)
      .filter((name) => !taken.has(name)),
    headRepo,
    headFailed,
    forks: theirs.map((f) => ({ namespace: f.namespace, name: f.name })),
    forksFailed: isFailed(forks) ? forks : null,
    selected: query.get("branch") ?? head.branch,
    item: query.get("item") ?? "",
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const item = Number(form.get("item"));
  // From a fork: `namespace/name`; absent for a branch of this repository.
  const [headNamespace, headName] = String(form.get("headRepo") ?? "").split("/");
  const result = await work.openPull(
    user,
    { namespace: params.owner, name: params.repo },
    {
      branch: String(form.get("branch") ?? ""),
      headRepo: headNamespace && headName ? { namespace: headNamespace, name: headName } : undefined,
      title: String(form.get("title") ?? ""),
      body: String(form.get("body") ?? ""),
      item: item > 0 ? item : undefined,
      agent: user.username,
      runtime: "external",
      base: String(form.get("base") ?? "") || undefined,
      draft: form.get("intent") === "draft",
    },
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${params.owner}/${params.repo}/pull/${result.value.number}`);
}

export default function NewPull({ loaderData, actionData, params }: Route.ComponentProps) {
  const { defaultBranch, base, bases, branches, selected, item, headRepo, headFailed, forks, forksFailed } = loaderData;
  const navigate = useNavigate();
  const self = `${params.owner}/${params.repo}`;
  const from = headRepo ? `${headRepo.namespace}/${headRepo.name}` : self;
  const remote = cloneUrl(useAddresses(), from);
  // Another repository's branches come with the page: choosing one loads them.
  const choose = (repo: string) => {
    const next = new URLSearchParams({ base });
    if (repo !== self) next.set("head", `${repo}:`);
    if (item) next.set("item", item);
    navigate(`?${next}`, { replace: true });
  };
  const picker =
    forks.length > 0 ? (
      <Select value={from} onValueChange={choose}>
        <SelectTrigger aria-label="Repository the change is in" size="sm" className="w-auto max-w-full min-w-40 font-mono">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={self} icon={<Box />} className="font-mono">
            {self}
          </SelectItem>
          {forks.map((fork) => (
            <SelectItem key={`${fork.namespace}/${fork.name}`} value={`${fork.namespace}/${fork.name}`} icon={<GitFork />} className="font-mono">
              {fork.namespace}/{fork.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    ) : null;

  // Forks that could not be read: it says so under the repository the change is in.
  const forksNote = forksFailed ? <Unavailable what={forksFailed.what} compact /> : null;

  if (headFailed) {
    return (
      <div className="max-w-2xl space-y-4">
        {picker && (
          <Card className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
            <span className="text-muted">From</span>
            {picker}
          </Card>
        )}
        <Unavailable what={headFailed.what} />
      </div>
    );
  }

  if (branches.length === 0) {
    return (
      <div className="max-w-2xl">
        {picker && (
          <Card className="mb-4 flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
            <span className="text-muted">From</span>
            {picker}
          </Card>
        )}
        {forksNote && <div className="mb-4">{forksNote}</div>}
        <EmptyState title="No branch to open a pull request from">
          {headRepo ? `Push a branch with your change to ${from}, then come back.` : "Push a branch to this repository, then come back."}
        </EmptyState>
        <div className="mt-4 space-y-2">
          <CopyLine prompt text="git switch -c my-change" />
          <CopyLine prompt text={`git push ${remote} my-change`} />
        </div>
        <p className="mt-4 text-sm text-muted">
          A coding agent connected through the MCP server does not need a branch: it can
          open a draft pull request for a work item and get a fork of its own to push to.
        </p>
      </div>
    );
  }

  return (
    <Form method="post" className="max-w-2xl space-y-4">
      <Card className="flex flex-wrap items-center gap-2 px-4 py-3 text-sm">
        <GitBranch size={15} className="text-faint" />
        <span className="text-muted">Merge</span>
        {picker}
        {headRepo && <input type="hidden" name="headRepo" value={from} />}
        <Combobox
          key={from}
          name="branch"
          defaultValue={branches.includes(selected) ? selected : branches[0]}
          aria-label="Branch to merge"
          searchPlaceholder="Find a branch"
          emptyText="No branch by that name."
          options={branches.map((name) => ({ value: name, label: name, icon: <GitBranch /> }))}
          className="h-8 w-auto max-w-full min-w-40 font-mono"
        />
        <span className="text-muted">into</span>
        <Combobox
          name="base"
          defaultValue={base}
          aria-label="Branch to merge into"
          searchPlaceholder="Find a branch"
          emptyText="No branch by that name."
          options={bases.map((name) => ({
            value: name,
            label: name,
            icon: <GitBranch />,
            description: name === defaultBranch ? "default" : undefined,
          }))}
          className="h-8 w-auto max-w-full min-w-32 font-mono"
        />
      </Card>
      {forksNote}
      <Field label="Title">
        <Input name="title" required autoFocus maxLength={200} />
      </Field>
      <Field label="Description" hint="What changed and why. Markdown works.">
        <Textarea name="body" rows={8} />
      </Field>
      <Field
        label="Work item (optional)"
        hint={`The number of the workspace's work item this is for. Merging the pull request into ${defaultBranch} lands it here.`}
      >
        <Input name="item" type="number" inputMode="numeric" min={1} defaultValue={item} placeholder="12" />
      </Field>
      <ErrorText>{actionData?.error}</ErrorText>
      <div className="flex flex-wrap items-center gap-2">
        <SubmitButton name="intent" value="open" match={{ intent: "open" }} pending="Opening…">
          Open pull request
        </SubmitButton>
        <SubmitButton name="intent" value="draft" match={{ intent: "draft" }} variant="outline" pending="Opening…">
          Open as draft
        </SubmitButton>
        <span className="text-xs text-faint">A draft can't merge until you mark it ready.</span>
      </div>
    </Form>
  );
}
