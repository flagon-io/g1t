import { ArrowDownLeft, ArrowUpRight, FileCode2, Network, Trash2 } from "lucide-react";
import { Form, Link } from "react-router";

import type { DependencyLink } from "@g1t/contracts";

import type { Route } from "./+types/settings-dependencies";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { Avatar, EmptyState, ErrorText, Field, Input, SubmitButton } from "../../components/ui";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import { projects } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, unwrap } from "../../lib/session.server";
import { requireCapability, requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Dependencies · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Admins; to anyone without a role here the page does not exist.
  await requireInsider(context, params, "manage_settings");
  const [deps, all] = await Promise.all([
    projects.dependencies(params.owner, params.repo, viewer),
    projects.list(params.owner, viewer),
  ]);
  return { dependencies: unwrap(deps), projects: all.ok ? all.value : [] };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  await requireCapability(context, params, "manage_settings");
  const form = await request.formData();
  const on = String(form.get("on") ?? "");
  if (form.get("intent") === "remove") {
    const done = await projects.removeDependency(user, params.owner, params.repo, on);
    return done.ok ? { notice: `No longer depends on ${on}.` } : { error: done.error.message };
  }
  const added = await projects.addDependency(user, params.owner, params.repo, on, String(form.get("as") ?? "") || null);
  return added.ok ? { notice: `Depends on ${on}.` } : { error: added.error.message };
}

function Row({ link, base, removable }: { link: DependencyLink; base: string; removable: boolean }) {
  return (
    <li className="flex items-center gap-3 px-4 py-3 text-sm">
      <Link to={`/${base.split("/")[1]}/${link.slug}`} className="font-medium hover:underline">
        {link.name}
      </Link>
      {link.as ? (
        <code className="rounded bg-raised px-1.5 py-0.5 font-mono text-xs text-muted">{link.as}</code>
      ) : (
        <span className="text-xs text-faint">no variable</span>
      )}
      {link.source === "file" && (
        <span className="inline-flex items-center gap-1 text-xs text-faint" title="Declared in .g1t/project.yml">
          <FileCode2 size={12} />
          project.yml
        </span>
      )}
      {removable && link.source === "ui" && (
        <Form method="post" className="ml-auto">
          <input type="hidden" name="intent" value="remove" />
          <input type="hidden" name="on" value={link.slug} />
          <SubmitButton
            icon
            match={{ intent: "remove", on: link.slug }}
            aria-label={`Stop depending on ${link.name}`}
            className="rounded-md p-1.5 text-faint transition-colors hover:bg-raised hover:text-danger disabled:opacity-50"
          >
            <Trash2 size={14} />
          </SubmitButton>
        </Form>
      )}
    </li>
  );
}

export default function DependencySettings({ loaderData, actionData, params }: Route.ComponentProps) {
  const { dependencies, projects: all } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const taken = new Set([params.repo.toLowerCase(), ...dependencies.dependsOn.map((d) => d.slug)]);
  const choices = all.filter((project) => !taken.has(project.slug));
  return (
    <div className="max-w-4xl">
      <RepoSettingsHeading base={base} />
      <header>
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Network size={15} className="text-accent" />
          Dependencies
        </h2>
        <p className="mt-1 max-w-2xl text-sm text-muted">
          The projects this one uses: calls their API, consumes their package. Its builds and its running app get each
          one's address for the same environment under the variable you name, a preview pointing at the same branch's
          preview when there is one. Agents working here are told what uses this project.{" "}
          <a href="https://docs.g1t.sh/guides/projects/#dependencies" className="text-fg hover:underline">
            How dependencies work
          </a>
        </p>
      </header>

      <div className="mt-4 min-h-6">
        {actionData && "notice" in actionData && <p className="text-sm text-accent">{actionData.notice}</p>}
        <ErrorText>{actionData && "error" in actionData ? actionData.error : null}</ErrorText>
      </div>

      <section>
        <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
          <ArrowUpRight size={13} />
          Depends on
        </h3>
        <div className="mt-2">
          {dependencies.dependsOn.length === 0 ? (
            <EmptyState title="Uses no other project" />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {dependencies.dependsOn.map((link) => (
                <Row key={link.slug} link={link} base={base} removable />
              ))}
            </ul>
          )}
        </div>
        {choices.length > 0 && (
          // Keyed to what it depends on, so once one is added the form starts over on what is left.
          <Form
            key={dependencies.dependsOn.map((link) => link.slug).join(" ")}
            method="post"
            className="mt-4 grid items-end gap-3 rounded-xl border border-line bg-surface p-4 sm:grid-cols-[1fr_1fr_auto]"
          >
            <input type="hidden" name="intent" value="add" />
            <Field label="Project">
              <Select name="on" required defaultValue={choices[0].slug}>
                <SelectTrigger aria-label="Project" className="h-auto py-2">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {choices.map((project) => (
                    <SelectItem
                      key={project.slug}
                      value={project.slug}
                      icon={<Avatar name={project.name} size={16} square />}
                      description={project.slug !== project.name ? project.slug : undefined}
                    >
                      {project.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field label="Its address as">
              <Input name="as" placeholder="API_URL" className="font-mono" />
            </Field>
            <SubmitButton match={{ intent: "add" }} pending="Adding…">
              Add dependency
            </SubmitButton>
          </Form>
        )}
      </section>

      <section className="mt-10">
        <h3 className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted uppercase">
          <ArrowDownLeft size={13} />
          Used by
        </h3>
        <div className="mt-2">
          {dependencies.usedBy.length === 0 ? (
            <EmptyState title="No project uses this one yet" />
          ) : (
            <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
              {dependencies.usedBy.map((link) => (
                <Row key={link.slug} link={link} base={base} removable={false} />
              ))}
            </ul>
          )}
        </div>
      </section>

      <section className="mt-10 rounded-xl border border-line p-5 text-sm">
        <h3 className="flex items-center gap-2 font-medium">
          <FileCode2 size={15} className="text-faint" />
          Or declare them in the code
        </h3>
        <p className="mt-1 text-muted">
          A <code className="text-fg">.g1t/project.yml</code> in the project's root directory is read on every push to
          the default branch, and its dependencies replace the ones it declared before:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg border border-line bg-bg p-3 font-mono text-xs text-muted">{`dependsOn:
  - project: api
    as: API_URL
  - project: ui-kit`}</pre>
      </section>
    </div>
  );
}
