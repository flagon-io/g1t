/**
 * Forking a repository into one of the viewer's workspaces: where it goes,
 * its name and description, and whether only the default branch is
 * copied. The fork keeps a link to where it came from, for syncing and for
 * pull requests back to it.
 */
import { GitFork } from "lucide-react";
import { useState } from "react";
import { Form, redirect } from "react-router";

import { DEFAULT_MEMBER_PRIVILEGES } from "@g1t/contracts";

import type { Route } from "./+types/fork";
import { ErrorText, SubmitButton } from "../../components/ui";
import { CheckboxOption } from "../../components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field";
import { Input, InputAddon, InputGroup } from "../../components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { requireRepo } from "../../lib/access.server";
import { page } from "../../lib/meta";
import { tidyName } from "../../lib/repo-lifecycle";
import { repos } from "../../lib/services.server";
import { assertSameOrigin, requireUser } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Fork · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const { repo } = await requireRepo(context, params, "read");
  // The workspaces where the person may make a repository as visible as
  // this one: a fork is as visible as its source.
  const destinations = (user.workspaces ?? [])
    .filter((m) => m.code_access !== false)
    .filter((m) => {
      if (m.role === "owner") return true;
      const privileges = { ...DEFAULT_MEMBER_PRIVILEGES, ...(m.privileges ?? {}) };
      return repo.isPrivate ? privileges.members_can_create_private_repositories : privileges.members_can_create_public_repositories;
    })
    .map((m) => ({ slug: m.slug, name: m.name?.trim() || m.slug }));
  // Another workspace first: forking into the same one needs another name.
  const own = repo.namespace.toLowerCase();
  const selected = destinations.find((d) => d.slug !== own)?.slug ?? destinations[0]?.slug ?? "";
  return {
    source: {
      namespace: repo.namespace,
      name: repo.name,
      isPrivate: repo.isPrivate,
      defaultBranch: repo.defaultBranch,
      forkable: !repo.isPrivate || Boolean(repo.allowForking),
    },
    destinations,
    selected,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const text = (name: string) => String(form.get(name) ?? "").trim();
  const result = await repos.fork(user, { namespace: params.owner, name: params.repo }, {
    namespace: text("workspace"),
    name: tidyName(text("name")) || undefined,
    defaultBranchOnly: form.get("defaultBranchOnly") != null,
  });
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${result.value.namespace}/${result.value.name}`);
}

export default function Fork({ loaderData, actionData }: Route.ComponentProps) {
  const { source, destinations, selected } = loaderData;
  const full = `${source.namespace}/${source.name}`;
  const [workspace, setWorkspace] = useState(selected);
  const [name, setName] = useState(source.name);
  const wanted = tidyName(name) || source.name;
  const onto = workspace.toLowerCase() === source.namespace.toLowerCase() && wanted === source.name.toLowerCase();
  return (
    <div className="max-w-2xl">
      <div className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/30">
          <GitFork size={18} />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold tracking-tight">Fork {full}</h2>
          <p className="mt-1 text-sm text-muted">
            A copy of its code in a workspace of yours, to change as you like. It remembers where it came from, so you can
            bring in what lands there and open pull requests back to it.
          </p>
        </div>
      </div>

      {!source.forkable ? (
        <p className="mt-8 text-sm text-muted">
          {full} is private, and its admins have not allowed forking it. They can in its settings.
        </p>
      ) : destinations.length === 0 ? (
        <p className="mt-8 text-sm text-muted">
          None of your workspaces lets you make a {source.isPrivate ? "private" : "public"} repository, so there is nowhere
          to fork it. Ask an owner of one to allow it in its member privileges, or create a workspace of your own.
        </p>
      ) : (
        <Form method="post" className="mt-8 space-y-6">
          <Field>
            <FieldLabel htmlFor="fork-name">Where and what to call it</FieldLabel>
            <InputGroup className="h-10">
              <Select name="workspace" value={workspace} onValueChange={setWorkspace}>
                <SelectTrigger
                  aria-label="Workspace"
                  className="h-full w-auto max-w-[55%] shrink-0 rounded-none border-0 border-r border-line bg-surface font-medium shadow-none focus-visible:ring-0 data-[state=open]:ring-0 sm:max-w-[45%]"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {destinations.map((d) => (
                    <SelectItem key={d.slug} value={d.slug}>
                      {d.name === d.slug ? d.slug : `${d.name} (${d.slug})`}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <InputAddon className="px-2 font-mono text-base text-faint">/</InputAddon>
              <Input
                id="fork-name"
                name="name"
                required
                maxLength={100}
                spellCheck={false}
                autoCapitalize="off"
                value={name}
                onChange={(event) => setName(event.target.value)}
                aria-invalid={onto || undefined}
                className="pl-1 font-mono"
              />
            </InputGroup>
            <FieldDescription>
              {onto ? (
                <span className="text-danger">That is {full} itself. Choose another name or workspace.</span>
              ) : (
                <>
                  At{" "}
                  <span className="font-mono text-muted">
                    g1t.sh/{workspace}/<span className="text-fg">{wanted}</span>
                  </span>
                  . It is {source.isPrivate ? "private" : "public"}, as {full} is.
                </>
              )}
            </FieldDescription>
          </Field>

          <CheckboxOption
            name="defaultBranchOnly"
            defaultChecked
            label={
              <>
                Copy the <span className="font-mono">{source.defaultBranch}</span> branch only
              </>
            }
            description="Other branches and tags are not copied. Leave it off to copy every branch and tag."
          />

          <ul className="list-disc space-y-1.5 pl-5 text-sm text-muted">
            <li>Its code and description are copied. Its settings, secrets, variables, rules, webhooks, deployments, issues and pull requests are not.</li>
            <li>Workflows do not run in the fork until you turn Actions on, and Issues start off.</li>
            <li>Its size counts toward the storage of the workspace it goes in.{source.isPrivate ? " A free workspace may not have room for it." : ""}</li>
          </ul>

          <ErrorText>{actionData?.error}</ErrorText>
          <SubmitButton variant="accent" pending="Forking…" disabled={onto || !workspace}>
            Create fork
          </SubmitButton>
        </Form>
      )}
    </div>
  );
}
