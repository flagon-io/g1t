import { GitBranch } from "lucide-react";
import { Form, redirect } from "react-router";

import type { Route } from "./+types/pull-new";
import { page } from "../../lib/meta";
import { cloneUrl, useAddresses } from "../../lib/addresses";
import { Combobox } from "../../components/ui/combobox";
import {
  SubmitButton,
  CopyLine,
  EmptyState,
  ErrorText,
  Field,
  Input,
  Textarea,
} from "../../components/ui";
import { repos, work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `New pull request · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const path = { namespace: params.owner, name: params.repo };
  const [repo, branches, open] = await Promise.all([
    repos.get(path, user),
    repos.branches(path, user),
    work.listPulls(path, user, "open"),
  ]);
  const { defaultBranch } = unwrap(repo);
  const all = unwrap(branches);
  const mainHead = all.find((branch) => branch.name === defaultBranch)?.hash;
  // A branch that already has an open pull request cannot have another.
  const taken = new Set(open.ok ? open.value.map((pull) => pull.branch) : []);
  const query = new URL(request.url).searchParams;
  return {
    defaultBranch,
    branches: all
      // A branch at the same commit as the default branch has nothing to merge.
      .filter((branch) => branch.name !== defaultBranch && branch.hash !== mainHead)
      .map((branch) => branch.name)
      .filter((name) => !taken.has(name)),
    selected: query.get("branch") ?? "",
    issue: query.get("issue") ?? "",
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const issue = Number(form.get("issue"));
  const result = await work.openPull(
    user,
    { namespace: params.owner, name: params.repo },
    {
      branch: String(form.get("branch") ?? ""),
      title: String(form.get("title") ?? ""),
      body: String(form.get("body") ?? ""),
      issue: issue > 0 ? issue : undefined,
      agent: user.username,
      runtime: "external",
    },
  );
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${params.owner}/${params.repo}/pull/${result.value.number}`);
}

export default function NewPull({ loaderData, actionData, params }: Route.ComponentProps) {
  const { defaultBranch, branches, selected, issue } = loaderData;
  const remote = cloneUrl(useAddresses(), `${params.owner}/${params.repo}`);

  if (branches.length === 0) {
    return (
      <div className="max-w-2xl">
        <EmptyState title="No branch to open a pull request from">
          Push a branch to this repository, then come back.
        </EmptyState>
        <div className="mt-4 space-y-2">
          <CopyLine prompt text="git switch -c my-change" />
          <CopyLine prompt text={`git push ${remote} my-change`} />
        </div>
        <p className="mt-4 text-sm text-muted">
          Agents do not need a branch. Open an issue and assign agents to it,
          and each gets a pull request with its own fork.
        </p>
      </div>
    );
  }

  return (
    <Form method="post" className="max-w-2xl space-y-4">
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface px-4 py-3 text-sm">
        <GitBranch size={15} className="text-faint" />
        <span className="text-muted">Merge</span>
        <Combobox
          name="branch"
          defaultValue={branches.includes(selected) ? selected : branches[0]}
          aria-label="Branch to merge"
          searchPlaceholder="Find a branch"
          emptyText="No branch by that name."
          options={branches.map((name) => ({ value: name, label: name, icon: <GitBranch /> }))}
          className="h-8 w-auto max-w-full min-w-40 font-mono"
        />
        <span className="text-muted">into</span>
        <span className="font-mono">{defaultBranch}</span>
      </div>
      <Field label="Title">
        <Input name="title" required autoFocus maxLength={200} />
      </Field>
      <Field label="Description" hint="What changed and why. Markdown works.">
        <Textarea name="body" rows={8} />
      </Field>
      <Field
        label="Issue (optional)"
        hint="The number of the issue this resolves. Merging the pull request closes it."
      >
        <Input name="issue" type="number" min={1} defaultValue={issue} placeholder="12" />
      </Field>
      <ErrorText>{actionData?.error}</ErrorText>
      <SubmitButton pending="Opening…">Open pull request</SubmitButton>
    </Form>
  );
}
