import { Box, Download, GitBranch, Globe, Lock, Sparkles } from "lucide-react";
import { useState } from "react";
import { Form, redirect, useNavigate, useNavigation } from "react-router";

import type { Route } from "./+types/new";
import { page } from "../lib/meta";
import { Avatar, Button, ErrorText } from "../components/ui";
import { Field, FieldDescription, FieldLabel, FieldLegend, FieldSet } from "../components/ui/field";
import { Input, InputAddon, InputGroup } from "../components/ui/input";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../components/ui/select";
import { repos } from "../lib/services.server";
import { GithubMark } from "../components/github";
import { githubApp } from "../lib/github.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "New project · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const workspaces = (user.workspaces ?? []).map((membership) => ({
    slug: membership.slug,
    role: membership.role,
    name: membership.name ?? membership.slug,
    avatar: membership.avatar ?? null,
  }));
  // Projects live in a workspace, so there has to be one first.
  if (workspaces.length === 0) throw redirect("/workspaces/new");
  const asked = new URL(request.url).searchParams.get("workspace");
  const selected = asked && workspaces.some((workspace) => workspace.slug === asked) ? asked : workspaces[0].slug;
  // With g1t's GitHub App configured, repositories can come from GitHub.
  const github = await githubApp.status(user, selected).catch(() => null);
  return { workspaces, selected, github: Boolean(github?.ok && github.value.configured) };
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
    icon: <Sparkles />,
  },
  {
    id: "import",
    title: "Import code",
    text: "Copy a public repository from GitHub or any git host into a new one on g1t.",
    icon: <Download />,
  },
  {
    id: "mirror",
    title: "Mirror GitHub, GitLab or Bitbucket",
    text: "Keep the code where it is and work on it with g1t. Deployments are yours to turn on.",
    icon: <GitBranch />,
    soon: true,
  },
];

const ROLE_LABELS: Record<string, string> = { owner: "Owner", admin: "Admin", member: "Member" };

/** Replaces the mirror card when g1t's GitHub App is configured. */
const GITHUB_SOURCE = {
  id: "github" as const,
  title: "Import from GitHub",
  text: "Import, mirror or move repositories you can reach on GitHub, private ones too.",
  icon: <GithubMark />,
  soon: false,
};

export default function NewProject({ loaderData, actionData }: Route.ComponentProps) {
  const [source, setSource] = useState<Source>("empty");
  const navigate = useNavigate();
  const sources = loaderData.github ? SOURCES.map((option) => (option.id === "mirror" ? GITHUB_SOURCE : option)) : SOURCES;
  const [workspace, setWorkspace] = useState(loaderData.selected);
  const [name, setName] = useState("");
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
        <FieldSet>
          <FieldLegend>Where its code comes from</FieldLegend>
          <RadioGroup
            name="source"
            value={source}
            onValueChange={(value) =>
              value === "github" ? navigate(`/new/github?workspace=${workspace}`) : setSource(value as Source)
            }
            aria-label="Where its code comes from"
            className="gap-3 sm:grid-cols-3"
          >
            {sources.map((option) => (
              <RadioCard
                key={option.id}
                value={option.id}
                title={option.title}
                description={option.text}
                icon={option.icon}
                disabled={option.soon}
                badge={option.soon ? "Soon" : undefined}
              />
            ))}
          </RadioGroup>
        </FieldSet>

        {source === "import" && (
          <Field className="animate-fade-in">
            <FieldLabel htmlFor="importUrl">Repository to import</FieldLabel>
            <Input id="importUrl" name="importUrl" type="url" required placeholder="https://github.com/owner/repo" />
            <FieldDescription>The address of a public repository. Its default branch is copied, up to 40 MB.</FieldDescription>
          </Field>
        )}

        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <InputGroup className="h-10">
            <Select name="workspace" value={workspace} onValueChange={setWorkspace}>
              <SelectTrigger
                aria-label="Workspace"
                className="h-full w-auto max-w-[55%] shrink-0 rounded-none border-0 bg-surface px-2.5 font-medium hover:bg-raised focus-visible:ring-0 data-[state=open]:bg-raised data-[state=open]:ring-0 sm:max-w-[45%]"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start" className="min-w-64">
                <SelectGroup>
                  <SelectLabel>Workspaces</SelectLabel>
                  {loaderData.workspaces.map((option) => (
                    <SelectItem
                      key={option.slug}
                      value={option.slug}
                      icon={<Avatar name={option.name} image={option.avatar} size={18} square />}
                      description={`g1t.sh/${option.slug} · ${ROLE_LABELS[option.role] ?? option.role}`}
                    >
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
            <InputAddon className="border-l border-line px-2 font-mono text-base text-faint">/</InputAddon>
            <Input
              id="name"
              name="name"
              required
              autoFocus
              maxLength={100}
              placeholder="my-app"
              value={name}
              onChange={(event) => setName(event.target.value)}
              className="pl-1 font-mono"
            />
          </InputGroup>
          <FieldDescription>
            The project and its repository share it:{" "}
            <span className="font-mono text-muted">
              g1t.sh/{workspace}/<span className={name ? "text-fg" : undefined}>{name || "name"}</span>
            </span>
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="description">
            Description <span className="font-normal text-faint">(optional)</span>
          </FieldLabel>
          <Input id="description" name="description" maxLength={200} placeholder="What it is, in a line" />
        </Field>

        <FieldSet>
          <FieldLegend>Who can see it</FieldLegend>
          <RadioGroup name="visibility" defaultValue="public" aria-label="Who can see it" className="gap-3 sm:grid-cols-2">
            <RadioCard
              value="public"
              icon={<Globe />}
              title="Public"
              description="Anyone can see its code and open issues."
            />
            <RadioCard
              value="private"
              icon={<Lock />}
              title="Private"
              description="Only members of the workspace."
            />
          </RadioGroup>
        </FieldSet>

        <ErrorText>{actionData?.error}</ErrorText>
        <Button type="submit" variant="accent" disabled={busy}>
          Create project
        </Button>
      </Form>
    </main>
  );
}
