import { Box, Code2, GitBranch, Image as ImageIcon, Link2, Rocket } from "lucide-react";
import { useState } from "react";
import { Form, Link, redirect } from "react-router";

import { DEFAULT_MEMBER_PRIVILEGES } from "@g1t/contracts";

import type { Route } from "./+types/settings";
import { LIFECYCLE_INTENTS, type LifecycleIntent, ProjectDangerZone } from "../../components/project-lifecycle";
import { confirmsName } from "../../lib/repo-lifecycle";
import { page } from "../../lib/meta";
import { useAddresses } from "../../lib/addresses";
import { productionImageUrl, readProductionImageUpload } from "../../lib/production-image";
import { KindFields, LinkFields } from "../../components/project-about";
import { ProductionImageField } from "../../components/production-image-field";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { ErrorText, Field, Input, SubmitButton, TimeAgo } from "../../components/ui";
import { Card } from "../../components/ui/card";
import { KIND_CHOICE_SETS, type KindChoice, choiceOf, linksFromForm, neverDeploys } from "../../lib/project-kind";
import { deployments, identity, projects, repos } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { refusal, requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Settings · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up; to anyone without a role here the page does not exist.
  const { repo, access } = await requireInsider(context, params, "manage_settings");
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
    // Archiving is for Admins; transferring and deleting, for owners of the
    // workspace unless its member privileges let its members with Admin.
    lifecycle: access.can.administer
      ? { archived: Boolean(repo.archivedAt), remove: access.can.delete, destinations: destinations(viewer, params.owner, repo.isPrivate, access.can.delete) }
      : null,
  };
}

/** Where it can be transferred: a workspace where the person can create a repository like it. */
function destinations(viewer: ReturnType<typeof getViewer>, from: string, isPrivate: boolean, allowed: boolean): { slug: string; name: string }[] {
  if (!allowed) return [];
  return (viewer?.workspaces ?? [])
    .filter((m) => m.slug !== from.toLowerCase())
    .filter((m) => {
      if (m.role === "owner") return true;
      const privileges = { ...DEFAULT_MEMBER_PRIVILEGES, ...(m.privileges ?? {}) };
      return isPrivate ? privileges.members_can_create_private_repositories : privileges.members_can_create_public_repositories;
    })
    .map((m) => ({ slug: m.slug, name: m.name ?? m.slug }));
}

/** Archiving, transferring and deleting: the repository goes with the project. */
async function lifecycle(intent: LifecycleIntent, form: FormData, request: Request, params: Route.ActionArgs["params"], context: Route.ActionArgs["context"]) {
  const user = requireUser(context, request);
  const refused = await refusal(context, params, intent === "archive" ? "administer" : "delete");
  if (refused) return { lifecycle: intent, error: refused };
  const path = { namespace: params.owner, name: params.repo };
  const full = `${params.owner}/${params.repo}`;
  const typed = String(form.get("confirm") ?? "").trim();
  const failed = (result: { ok: false; error: { message: string } }) => ({ lifecycle: intent, error: result.error.message });
  switch (intent) {
    case "archive": {
      const done = await repos.archive(user, path, form.get("archived") === "true");
      return done.ok ? { lifecycle: intent, error: null } : failed(done);
    }
    case "transfer": {
      // repos checks both workspaces' owners, the name and storage, and
      // keeps the old address as a redirect.
      if (!confirmsName(typed, full)) return { lifecycle: intent, error: `Type ${full} to confirm.` };
      const moved = await repos.transfer(
        user,
        path,
        String(form.get("to") ?? "")
          .trim()
          .toLowerCase(),
      );
      if (!moved.ok) return failed(moved);
      throw redirect(`/${moved.value.namespace}/${moved.value.name}/settings`);
    }
    case "delete": {
      if (!confirmsName(typed, full)) return { lifecycle: intent, error: `Type ${full} to confirm.` };
      const deleted = await repos.delete(user, path, typed);
      if (!deleted.ok) return failed(deleted);
      throw redirect(`/${params.owner}/-/settings/repositories?deleted=${encodeURIComponent(deleted.value.name)}`);
    }
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const intent = form.get("intent");
  if (LIFECYCLE_INTENTS.includes(intent as LifecycleIntent)) {
    return lifecycle(intent as LifecycleIntent, form, request, params, context);
  }
  await requireCapability(context, params, "manage_settings");
  // Production's picture on the overview: whoever may change its address may change it.
  if (intent === "production-image" || intent === "remove-production-image" || intent === "prefer-production-image") {
    let change: { image?: string | null; preferred?: boolean };
    if (intent === "production-image") {
      const upload = await readProductionImageUpload(form);
      if ("error" in upload) return { error: upload.error };
      change = { image: upload.image };
    } else {
      change = intent === "remove-production-image" ? { image: null } : { preferred: form.get("preferred") === "on" };
    }
    const saved = await projects.setProductionImage(user, params.owner, params.repo, change);
    return saved.ok ? { imageSaved: true as const } : { error: saved.error.message };
  }
  const choice = form.get("choice") as KindChoice | null;
  const set = choice && choice in KIND_CHOICE_SETS ? KIND_CHOICE_SETS[choice] : null;
  const saved = await projects.update(user, params.owner, params.repo, {
    name: String(form.get("name") ?? ""),
    // Blank clears it.
    description: String(form.get("description") ?? ""),
    rootDir: String(form.get("rootDir") ?? ""),
    ...(set ?? {}),
    // Production's address is asked for beside Deploys itself, and kept otherwise.
    ...(form.has("productionUrl") ? { productionUrl: String(form.get("productionUrl")) } : {}),
    homepage: String(form.get("homepage") ?? ""),
    docsUrl: String(form.get("docsUrl") ?? ""),
    links: linksFromForm(form),
  });
  return saved.ok ? { saved: true as const } : { error: saved.error.message };
}

export default function ProjectSettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { project, deploymentsOn, mine, creator, lifecycle } = loaderData;
  const [choice, setChoice] = useState<KindChoice | null>(choiceOf(project.setting));
  // Something that never deploys, while Deployments are on, is refused: they are turned off first.
  const stops = choice === "library" || choice === "tool" || choice === "other";
  const blocked = stops && !neverDeploys(project) && deploymentsOn === true;
  const base = `/${params.owner}/${params.repo}`;
  const source = project.source.kind === "hosted" ? project.source : null;
  const { usercontent } = useAddresses();
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
            Name and description
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Field label="Name" hint={`Its address stays g1t.sh/${project.workspace}/${project.slug}.`}>
              <Input name="name" defaultValue={project.name} required maxLength={100} />
            </Field>
            <Field label="Description" hint="What it is, in a line. Search, link previews and lists of repositories show it.">
              <Input
                key={project.description ?? ""}
                name="description"
                defaultValue={project.description ?? ""}
                maxLength={200}
                placeholder="What it is, in a line"
              />
            </Field>
          </div>
        </section>

        <section className="space-y-4">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Code2 size={15} className="text-accent" />
            Source
          </h2>
          {source && (
            <Card className="p-4 text-sm">
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
            </Card>
          )}
          <Field label="Root directory" hint="Where in the repository its code lives, such as apps/web. Builds run there. Empty for the whole repository.">
            <Input name="rootDir" defaultValue={source?.rootDir ?? ""} placeholder="apps/web" className="font-mono" />
          </Field>
        </section>

        <section className="scroll-mt-[calc(var(--topbar-h)+1rem)] space-y-4" id="kind">
          {/* Old links to #deploys land here too. */}
          <span id="deploys" />
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Rocket size={15} className="text-accent" />
            What it is
          </h2>
          <p className="max-w-2xl text-xs text-muted">
            Its overview follows: production for what is deployed, packages and releases for a library or a tool, and the steps that apply to it. Only an app or
            site hosted on g1t.page is asked to turn on Deployments.
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

        <section className="scroll-mt-[calc(var(--topbar-h)+1rem)] space-y-4" id="links">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Link2 size={15} className="text-accent" />
            Links
          </h2>
          <p className="max-w-2xl text-xs text-muted">
            Shown on its overview, its card, and its workspace's Repositories. Each is an http or https address; https:// is added when you leave it out.
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
        <ErrorText>{actionData && "error" in actionData && !("lifecycle" in actionData) ? actionData.error : null}</ErrorText>
      </Form>

      {/* Its own forms, sent as soon as an image is picked: outside the settings form. */}
      <section className="mt-10 scroll-mt-[calc(var(--topbar-h)+1rem)] space-y-4" id="production-image">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <ImageIcon size={15} className="text-accent" />
          Production image
        </h2>
        <p className="max-w-2xl text-xs text-muted">
          The picture on its overview's production card. A screenshot is taken by itself for an app hosted on g1t.page, and of production's address for one that
          deploys itself, about once a day and after each production deployment reported to g1t.
        </p>
        <ProductionImageField
          image={project.productionImage}
          src={project.productionImage ? productionImageUrl(project.productionImage.file, usercontent) : null}
          screenshots={project.runs === "g1t" || (project.runs === "elsewhere" && !!project.productionUrl)}
        />
      </section>

      {lifecycle && (
        <ProjectDangerZone
          full={`${params.owner}/${params.repo}`}
          archived={lifecycle.archived}
          remove={lifecycle.remove}
          destinations={lifecycle.destinations}
          error={(intent) => (actionData && "lifecycle" in actionData && actionData.lifecycle === intent ? actionData.error : null)}
        />
      )}
    </div>
  );
}
