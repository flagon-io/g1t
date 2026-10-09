import { Box, Code2, GitBranch, Link2, Rocket } from "lucide-react";
import { useState } from "react";
import { Form, Link } from "react-router";

import type { Route } from "./+types/settings";
import { page } from "../../lib/meta";
import { KindFields, LinkFields } from "../../components/project-about";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { ErrorText, Field, Input, SubmitButton, TimeAgo } from "../../components/ui";
import { KIND_CHOICE_SETS, type KindChoice, choiceOf, linksFromForm, neverDeploys } from "../../lib/project-kind";
import { deployments, identity, projects } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_settings");
  const [project, deploys] = await Promise.all([
    projects.get(params.owner, params.repo, viewer),
    // Whether Deployments are on: needs Admin, so unknown (null) below it.
    deployments.settings({ workspace: params.owner, slug: params.repo }, viewer).catch(() => null),
  ]);
  const found = unwrap(project);
  // Who made it is kept as an id: named by identity, or left out if it cannot say.
  const names = await identity.usernames([found.createdBy]).catch(() => ({}) as Record<string, string>);
  return {
    project: found,
    deploymentsOn: deploys?.ok ? deploys.value.enabled : null,
    mine: viewer?.id === found.createdBy,
    creator: names[found.createdBy] ?? null,
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_settings");
  const form = await request.formData();
  const choice = form.get("choice") as KindChoice | null;
  const set = choice && choice in KIND_CHOICE_SETS ? KIND_CHOICE_SETS[choice] : null;
  const saved = await projects.update(user, params.owner, params.repo, {
    name: String(form.get("name") ?? ""),
    // Blank, or the reset, and it follows the repository's description again.
    description: form.get("inherit") === "description" ? null : String(form.get("description") ?? ""),
    rootDir: String(form.get("rootDir") ?? ""),
    ...(set ?? {}),
    // Production's address is asked for beside Deployed elsewhere, and kept otherwise.
    ...(form.has("productionUrl") ? { productionUrl: String(form.get("productionUrl")) } : {}),
    homepage: String(form.get("homepage") ?? ""),
    docsUrl: String(form.get("docsUrl") ?? ""),
    links: linksFromForm(form),
  });
  return saved.ok ? { saved: true as const } : { error: saved.error.message };
}

export default function ProjectSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { project, deploymentsOn, mine, creator } = loaderData;
  const [choice, setChoice] = useState<KindChoice | null>(choiceOf(project.setting));
  // Something that never deploys, while Deployments are on, is refused: they are turned off first.
  const stops = choice === "library" || choice === "tool" || choice === "other";
  const blocked = stops && !neverDeploys(project) && deploymentsOn === true;
  const base = `/${params.owner}/${params.repo}`;
  const source = project.source.kind === "hosted" ? project.source : null;
  return (
    <div className="max-w-4xl">
      <RepoSettingsHeading base={base} />
      <Form method="post" className="space-y-8">
        {/* Enter in a field saves: the form's first submit button is the one
            Enter presses, and otherwise it would be the description reset. */}
        <button type="submit" name="intent" value="save" tabIndex={-1} aria-hidden="true" className="absolute size-0 overflow-hidden opacity-0" />
        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Box size={15} className="text-accent" />
            Project
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" hint={`Its address stays g1t.sh/${project.workspace}/${project.slug}.`}>
              <Input name="name" defaultValue={project.name} required maxLength={100} />
            </Field>
            <div>
              <Field
                label="Description"
                hint={
                  project.descriptionInherited
                    ? "Follows the repository's description. Write one to give the project its own."
                    : "The project's own. Empty follows the repository's description."
                }
              >
                <Input
                  key={`${project.descriptionInherited}:${project.description ?? ""}`}
                  name="description"
                  defaultValue={project.descriptionInherited ? "" : (project.description ?? "")}
                  maxLength={200}
                  placeholder={(project.descriptionInherited && project.description) || "What it is, in a line"}
                />
              </Field>
              {!project.descriptionInherited && (
                <SubmitButton
                  name="inherit"
                  value="description"
                  pending="Resetting…"
                  className="mt-1.5 inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg disabled:opacity-50"
                >
                  Use the repository's description
                </SubmitButton>
              )}
            </div>
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
                To keep it in step with a copy on another host, either way round, see{" "}
                <Link to={`${base}/settings/mirroring`} className="text-muted hover:text-fg">
                  Mirroring
                </Link>
                .
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

        <section className="scroll-mt-20 space-y-4" id="kind">
          {/* Old links to #deploys land here too. */}
          <span id="deploys" />
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Rocket size={15} className="text-accent" />
            What it is
          </h2>
          <p className="max-w-2xl text-xs text-muted">
            Its overview follows: production for what is deployed, packages and releases for a library or a tool, and
            the steps that apply to it. Only an app or site deployed on g1t is asked to turn on Deployments.
          </p>
          <KindFields project={project} choice={choice} onChoice={setChoice} />
          {blocked && (
            <p className="rounded-lg border border-warn/40 bg-warn/5 px-3.5 py-2.5 text-sm text-fg-soft">
              Deployments are on for {project.name}. Turn them off in{" "}
              <Link to={`${base}/settings/deployments`} className="text-fg underline underline-offset-4">
                Deployments settings
              </Link>{" "}
              first, then choose this here.
            </p>
          )}
        </section>

        <section className="scroll-mt-20 space-y-4" id="links">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Link2 size={15} className="text-accent" />
            Links
          </h2>
          <p className="max-w-2xl text-xs text-muted">
            Shown on its overview, its card, and its workspace's Projects. Each is an http or https address;
            https:// is added when you leave it out.
          </p>
          <LinkFields links={project.links} />
        </section>

        <div className="flex items-center gap-3">
          <SubmitButton name="intent" value="save" pending="Saving…" disabled={blocked}>
            Save
          </SubmitButton>
          {actionData && "saved" in actionData && <span className="text-sm text-success">Saved.</span>}
          <span className="ml-auto text-xs text-faint">
            Created{" "}
            {mine ? (
              "by you "
            ) : creator ? (
              <>
                by{" "}
                <Link to={`/${creator}`} className="text-muted hover:text-fg">
                  {creator}
                </Link>{" "}
              </>
            ) : null}
            <TimeAgo at={project.createdAt} />
          </span>
        </div>
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      </Form>
    </div>
  );
}
