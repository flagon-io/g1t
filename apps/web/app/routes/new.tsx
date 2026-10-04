import { Box, Download, GitBranch, Sparkles } from "lucide-react";
import { useState } from "react";
import { Form, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/new";
import { Button, ErrorText, Field, Input } from "../components/ui";
import { repos } from "../lib/services.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta({}: Route.MetaArgs) {
  return [{ title: "New project · g1t" }];
}

export function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const workspaces = (user.workspaces ?? []).map((membership) => membership.slug);
  // Projects live in a workspace, so there has to be one first.
  if (workspaces.length === 0) throw redirect("/workspaces/new");
  const asked = new URL(request.url).searchParams.get("workspace");
  return {
    workspaces,
    selected: asked && workspaces.includes(asked) ? asked : workspaces[0],
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  // A project hosted on g1t: its repository is made with it, and the
  // project takes the repository's name.
  const result = await repos.create(user, {
    namespace: String(form.get("workspace") ?? ""),
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    isPrivate: form.get("visibility") === "private",
    importUrl: form.get("source") === "import" ? String(form.get("importUrl") ?? "").trim() || undefined : undefined,
  });
  if (!result.ok) return { error: result.error.message };
  throw redirect(`/${result.value.namespace}/${result.value.name}`);
}

type Source = "empty" | "import";

const SOURCES: { id: Source | "mirror"; title: string; text: string; icon: React.ReactNode; soon?: boolean }[] = [
  {
    id: "empty",
    title: "Start empty",
    text: "A new repository on g1t. Push to it, or hand an agent the first issue.",
    icon: <Sparkles size={16} />,
  },
  {
    id: "import",
    title: "Import code",
    text: "Copy a public repository from GitHub or any git host into a new one on g1t.",
    icon: <Download size={16} />,
  },
  {
    id: "mirror",
    title: "Mirror GitHub, GitLab or Bitbucket",
    text: "Keep the code where it is and get g1t's deployments and agents on it.",
    icon: <GitBranch size={16} />,
    soon: true,
  },
];

export default function NewProject({ loaderData, actionData }: Route.ComponentProps) {
  const [source, setSource] = useState<Source>("empty");
  const busy = useNavigation().state === "submitting";
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <span className="flex size-10 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/30">
        <Box size={18} />
      </span>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">New project</h1>
      <p className="mt-1.5 text-sm text-muted">
        A project is what you build and run. Its code lives in its source; its deployments, environments, secrets and
        variables belong to the project.
      </p>

      <Form method="post" className="mt-8 space-y-8">
        <fieldset>
          <legend className="mb-3 text-sm font-medium text-muted">Where its code comes from</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {SOURCES.map((option) => {
              const chosen = source === option.id;
              return (
                <label
                  key={option.id}
                  className={`relative rounded-xl border p-4 transition-colors ${
                    option.soon
                      ? "cursor-not-allowed border-dashed border-line opacity-60"
                      : chosen
                        ? "cursor-pointer border-accent bg-accent/5"
                        : "cursor-pointer border-line hover:border-line-strong"
                  }`}
                >
                  <input
                    type="radio"
                    name="source"
                    value={option.id}
                    checked={chosen}
                    disabled={option.soon}
                    onChange={() => !option.soon && setSource(option.id as Source)}
                    className="sr-only"
                  />
                  <span className={chosen ? "text-accent" : "text-muted"}>{option.icon}</span>
                  <span className="mt-2 block text-sm font-medium">{option.title}</span>
                  <span className="mt-1 block text-xs text-muted">{option.text}</span>
                  {option.soon && (
                    <span className="absolute top-3 right-3 rounded-full bg-raised px-2 py-0.5 text-[0.6875rem] text-muted ring-1 ring-line">
                      Soon
                    </span>
                  )}
                </label>
              );
            })}
          </div>
        </fieldset>

        {source === "import" && (
          <Field
            label="Repository to import"
            hint="The address of a public repository. Its default branch is copied, up to 40 MB."
          >
            <Input name="importUrl" type="url" required placeholder="https://github.com/owner/repo" />
          </Field>
        )}

        <Field label="Name" hint="The project and its repository share it: g1t.sh/<workspace>/<name>.">
          <div className="flex items-center gap-2 font-mono text-sm">
            <select
              name="workspace"
              defaultValue={loaderData.selected}
              aria-label="Workspace"
              className="rounded-md border border-line bg-bg px-2 py-2 text-sm"
            >
              {loaderData.workspaces.map((slug) => (
                <option key={slug} value={slug}>
                  {slug}
                </option>
              ))}
            </select>
            <span className="text-muted">/</span>
            <Input name="name" required autoFocus maxLength={100} placeholder="my-app" />
          </div>
        </Field>
        <Field label="Description (optional)">
          <Input name="description" maxLength={200} placeholder="What it is, in a line" />
        </Field>
        <fieldset className="space-y-2 text-sm">
          <legend className="mb-2 font-medium text-muted">Who can see it</legend>
          <label className="flex items-center gap-2">
            <input type="radio" name="visibility" value="public" defaultChecked className="accent-accent" />
            Public: anyone can see its code and open issues
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="visibility" value="private" className="accent-accent" />
            Private: only members of the workspace
          </label>
        </fieldset>
        <ErrorText>{actionData?.error}</ErrorText>
        <Button type="submit" variant="accent" disabled={busy}>
          Create project
        </Button>
      </Form>
    </main>
  );
}
