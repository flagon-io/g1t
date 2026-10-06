import { ArrowLeft, Lock, Plus } from "lucide-react";
import { Form, Link, redirect, useNavigation } from "react-router";

import type { Route } from "./+types/new-github";
import { GithubMark } from "../components/github";
import { Button, ButtonLink, ErrorText, Pill } from "../components/ui";
import { CheckboxOption } from "../components/ui/checkbox";
import { FieldLegend, FieldSet } from "../components/ui/field";
import { RadioCard, RadioGroup } from "../components/ui/radio-group";
import { MODES } from "../lib/github";
import { githubApp } from "../lib/github.server";
import { page } from "../lib/meta";
import { assertSameOrigin, requireUser, roleIn } from "../lib/session.server";

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Import from GitHub · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const url = new URL(request.url);
  const workspaces = (user.workspaces ?? []).map((membership) => ({
    slug: membership.slug,
    name: membership.name ?? membership.slug,
    owner: membership.role === "owner",
  }));
  if (workspaces.length === 0) throw redirect("/workspaces/new");
  const asked = url.searchParams.get("workspace")?.toLowerCase();
  const workspace = workspaces.find((option) => option.slug === asked)?.slug ?? workspaces[0].slug;
  const status = await githubApp.status(user, workspace);
  if (!status.ok || !status.value.configured) throw redirect(`/new?workspace=${workspace}`);
  const { installations, linked } = status.value;
  const wanted = Number(url.searchParams.get("installation"));
  const installation = installations.find((item) => item.id === wanted) ?? installations[0] ?? null;
  const pageNumber = Math.max(1, Number(url.searchParams.get("page")) || 1);
  let repositories = null;
  let error: string | null = null;
  if (linked && installation) {
    const listed = await githubApp.repositories(user, workspace, installation.id, pageNumber);
    if (listed.ok) repositories = listed.value;
    else error = listed.error.message;
  }
  return {
    workspaces,
    workspace,
    owner: roleIn(user, workspace) === "owner",
    linked,
    installations,
    installation,
    repositories,
    error,
    requested: url.searchParams.get("requested") === "1",
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const workspace = String(form.get("workspace") ?? "");
  const installationId = Number(form.get("installation"));
  if (form.get("intent") === "remove-installation") {
    const removed = await githubApp.removeInstallation(user, workspace, installationId);
    if (!removed.ok) return { error: removed.error.message, results: [] };
    throw redirect(`/new/github?workspace=${encodeURIComponent(workspace)}`);
  }
  const mode = (["import", "mirror", "push"] as const).find((option) => option === form.get("mode")) ?? "import";
  const chosen = form.getAll("repo").map(Number).filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 20);
  if (chosen.length === 0) return { error: "Choose at least one repository.", results: [] };
  const issues = form.get("issues") === "on";
  // One at a time: each is a copy of a whole repository.
  const results: { id: number; ok: boolean; repo?: string; error?: string }[] = [];
  for (const githubRepoId of chosen) {
    const imported = await githubApp.import(user, workspace, { installationId, githubRepoId, mode, issues });
    results.push(
      imported.ok
        ? { id: githubRepoId, ok: true, repo: imported.value.repo }
        : { id: githubRepoId, ok: false, error: imported.error.message },
    );
  }
  if (results.length === 1 && results[0].ok) throw redirect(`/${results[0].repo}`);
  return { error: null, results };
}

export default function NewFromGithub({ loaderData, actionData }: Route.ComponentProps) {
  const { workspace, workspaces, installations, installation, repositories, linked, owner } = loaderData;
  const busy = useNavigation().state === "submitting";
  const here = `/new/github?workspace=${workspace}`;
  const names = new Map((repositories?.repositories ?? []).map((repo) => [repo.id, repo.fullName]));
  return (
    <main className="mx-auto max-w-2xl px-4 py-12">
      <Link to={`/new?workspace=${workspace}`} className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg">
        <ArrowLeft size={14} /> New project
      </Link>
      <span className="mt-6 flex size-10 items-center justify-center rounded-xl bg-accent/10 text-accent ring-1 ring-accent/30">
        <GithubMark className="size-[18px]" />
      </span>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">Import from GitHub</h1>
      <p className="mt-1.5 text-sm text-muted">
        Bring repositories into <span className="font-mono text-fg">{workspace}</span> through g1t's GitHub App. You choose
        which repositories it can see on GitHub; nothing else is read.
      </p>

      {workspaces.length > 1 && (
        <nav className="mt-6 flex flex-wrap gap-2" aria-label="Workspace">
          {workspaces.map((option) => (
            <Link
              key={option.slug}
              to={`/new/github?workspace=${option.slug}`}
              className={`rounded-full border px-3 py-1 text-sm ${option.slug === workspace ? "border-accent/60 text-fg" : "border-line text-muted hover:text-fg"}`}
            >
              {option.name}
            </Link>
          ))}
        </nav>
      )}

      {!linked ? (
        <section className="mt-8 rounded-lg border border-line p-6">
          <h2 className="font-medium">Connect your GitHub account</h2>
          <p className="mt-1.5 text-sm text-muted">
            g1t lists the repositories you can reach on GitHub as you, so it needs your GitHub account linked first.
          </p>
          <div className="mt-4">
            <a
              href={`/auth/github?link=1&next=${encodeURIComponent(here)}`}
              className="inline-flex items-center gap-2 rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-white"
            >
              <GithubMark /> Connect GitHub
            </a>
          </div>
        </section>
      ) : (
        <>
          <section className="mt-8">
            <div className="flex items-center justify-between gap-4">
              <h2 className="font-medium">GitHub accounts</h2>
              {owner && (
                <a
                  href={`/integrations/github/install?workspace=${workspace}`}
                  className="inline-flex items-center gap-1.5 text-sm text-muted hover:text-fg"
                >
                  <Plus size={14} /> Add a GitHub account
                </a>
              )}
            </div>
            {loaderData.requested && (
              <p className="mt-3 text-sm text-muted">
                Your request went to the organization's owners on GitHub. Once one approves it, add the account here again.
              </p>
            )}
            {installations.length === 0 ? (
              <div className="mt-3 rounded-lg border border-dashed border-line p-6 text-sm text-muted">
                {owner ? (
                  <>
                    <p>Install g1t's GitHub App on your GitHub account or an organization, and choose the repositories it may see.</p>
                    <div className="mt-4">
                      <a
                        href={`/integrations/github/install?workspace=${workspace}`}
                        className="inline-flex items-center gap-2 rounded-md bg-fg px-3.5 py-2 text-sm font-medium text-bg hover:bg-white"
                      >
                        <GithubMark /> Install on GitHub
                      </a>
                    </div>
                  </>
                ) : (
                  <p>No GitHub account is connected to this workspace yet. Ask one of its owners to add one.</p>
                )}
              </div>
            ) : (
              <ul className="mt-3 divide-y divide-line rounded-md border border-line">
                {installations.map((item) => (
                  <li key={item.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
                    <Link
                      to={`${here}&installation=${item.id}`}
                      className={`whitespace-nowrap ${item.id === installation?.id ? "font-medium text-fg" : "text-muted hover:text-fg"}`}
                    >
                      {item.account}
                    </Link>
                    <span className="whitespace-nowrap text-xs text-faint">
                      {item.accountType === "Organization" ? "Organization" : "Personal"} ·{" "}
                      {item.repositorySelection === "all" ? "all repositories" : "selected repositories"}
                    </span>
                    {item.suspended && <Pill>Suspended</Pill>}
                    <span className="ml-auto flex items-center gap-3">
                    <a href={item.settingsUrl} className="whitespace-nowrap text-xs text-muted hover:text-fg" target="_blank" rel="noreferrer">
                      Choose repositories on GitHub
                    </a>
                    {owner && (
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove-installation" />
                        <input type="hidden" name="workspace" value={workspace} />
                        <input type="hidden" name="installation" value={item.id} />
                        <button type="submit" className="text-xs text-faint hover:text-danger">
                          Remove
                        </button>
                      </Form>
                    )}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {installation && (
            <Form method="post" className="mt-10 space-y-8">
              <input type="hidden" name="workspace" value={workspace} />
              <input type="hidden" name="installation" value={installation.id} />
              <FieldSet>
                <FieldLegend>Repositories on {installation.account}</FieldLegend>
                <ErrorText>{loaderData.error}</ErrorText>
                {repositories && repositories.repositories.length === 0 && (
                  <p className="text-sm text-muted">
                    The app cannot see any repositories here yet.{" "}
                    <a href={installation.settingsUrl} className="text-fg underline underline-offset-4">
                      Choose some on GitHub
                    </a>
                    .
                  </p>
                )}
                <div className="divide-y divide-line rounded-md border border-line empty:hidden">
                  {(repositories?.repositories ?? []).map((repo) => (
                    <div key={repo.id} className="px-4 py-3">
                      <CheckboxOption
                        name="repo"
                        value={String(repo.id)}
                        disabled={repo.linkedTo != null}
                        label={
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-mono">{repo.fullName}</span>
                            {repo.private && (
                              <span className="inline-flex items-center gap-1 text-xs text-faint">
                                <Lock size={11} /> Private
                              </span>
                            )}
                            {repo.linkedTo && <Pill>On g1t as {repo.linkedTo}</Pill>}
                          </span>
                        }
                        description={repo.description ?? undefined}
                      />
                    </div>
                  ))}
                </div>
                {repositories && repositories.total > repositories.perPage && (
                  <div className="flex justify-between text-sm">
                    {repositories.page > 1 ? (
                      <Link to={`${here}&installation=${installation.id}&page=${repositories.page - 1}`} className="text-muted hover:text-fg">
                        Previous
                      </Link>
                    ) : (
                      <span />
                    )}
                    {repositories.page * repositories.perPage < repositories.total && (
                      <Link to={`${here}&installation=${installation.id}&page=${repositories.page + 1}`} className="text-muted hover:text-fg">
                        Next
                      </Link>
                    )}
                  </div>
                )}
              </FieldSet>

              <FieldSet>
                <FieldLegend>How it comes across</FieldLegend>
                <RadioGroup name="mode" defaultValue="import" aria-label="How it comes across" className="gap-3 sm:grid-cols-3">
                  {MODES.map((mode) => (
                    <RadioCard key={mode.id} value={mode.id} title={mode.title} description={mode.text} />
                  ))}
                </RadioGroup>
              </FieldSet>

              <CheckboxOption
                name="issues"
                defaultChecked
                label="Copy issues too"
                description="Up to 200 per repository, with their labels, milestone and whether they are open. Pull requests stay on GitHub; their branches come across."
              />

              {actionData?.results && actionData.results.length > 0 && (
                <ul className="space-y-1 rounded-md border border-line p-4 text-sm">
                  {actionData.results.map((result) => (
                    <li key={result.id}>
                      <span className="font-mono">{names.get(result.id) ?? result.id}</span>:{" "}
                      {result.ok ? (
                        <Link to={`/${result.repo}`} className="text-accent underline underline-offset-4">
                          {result.repo}
                        </Link>
                      ) : (
                        <span className="text-danger">{result.error}</span>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <ErrorText>{actionData?.error}</ErrorText>
              <div className="flex items-center gap-3">
                <Button type="submit" variant="accent" disabled={busy}>
                  {busy ? "Bringing them across…" : "Bring to g1t"}
                </Button>
                <ButtonLink to={`/new?workspace=${workspace}`} variant="quiet">
                  Cancel
                </ButtonLink>
              </div>
            </Form>
          )}
        </>
      )}
    </main>
  );
}
