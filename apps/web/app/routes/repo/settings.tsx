import { Box, Code2, GitBranch } from "lucide-react";
import { Form, Link, useNavigation } from "react-router";

import type { Route } from "./+types/settings";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { Button, ErrorText, Field, Input, TimeAgo } from "../../components/ui";
import { projects } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_settings");
  return { project: unwrap(await projects.get(params.owner, params.repo, viewer)) };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_settings");
  const form = await request.formData();
  const saved = await projects.update(user, params.owner, params.repo, {
    name: String(form.get("name") ?? ""),
    description: String(form.get("description") ?? ""),
    rootDir: String(form.get("rootDir") ?? ""),
  });
  return saved.ok ? { saved: true as const } : { error: saved.error.message };
}

export default function ProjectSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { project } = loaderData;
  const saving = useNavigation().state === "submitting";
  const base = `/${params.owner}/${params.repo}`;
  const source = project.source.kind === "hosted" ? project.source : null;
  return (
    <div className="max-w-4xl">
      <RepoSettingsHeading base={base} />
      <Form method="post" className="space-y-8">
        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Box size={15} className="text-accent" />
            Project
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" hint={`Its address stays g1t.sh/${project.workspace}/${project.slug}.`}>
              <Input name="name" defaultValue={project.name} required maxLength={100} />
            </Field>
            <Field label="Description">
              <Input name="description" defaultValue={project.description ?? ""} maxLength={200} placeholder="What it is, in a line" />
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Code2 size={15} className="text-accent" />
            Source
          </h2>
          {source && (
            <div className="rounded-xl border border-line bg-surface p-4 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <Link to={`${base}/code`} className="font-mono hover:text-accent">
                    {source.repo.namespace}/{source.repo.name}
                  </Link>
                  <p className="mt-0.5 text-xs text-muted">
                    Hosted on g1t · <GitBranch size={11} className="inline" /> {source.defaultBranch}
                  </p>
                </div>
                <Link to={`${base}/settings/repository`} className="text-xs text-muted hover:text-fg">
                  Repository settings
                </Link>
              </div>
              <p className="mt-3 text-xs text-faint">
                Mirroring a repository from GitHub, GitLab or Bitbucket as a project's source is coming next.
              </p>
            </div>
          )}
          <Field
            label="Root directory"
            hint="Where in the repository this project lives, such as apps/web. Builds run there. Empty for the whole repository."
          >
            <Input name="rootDir" defaultValue={source?.rootDir ?? ""} placeholder="apps/web" className="font-mono" />
          </Field>
        </section>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saving}>
            Save
          </Button>
          {actionData && "saved" in actionData && <span className="text-sm text-accent">Saved.</span>}
          <span className="ml-auto text-xs text-faint">
            Created by {project.createdBy} <TimeAgo at={project.createdAt} />
          </span>
        </div>
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      </Form>
    </div>
  );
}
