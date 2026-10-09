import type { DocTemplate, DocsHome } from "@g1t/contracts";
import { AlertTriangle, BookOpen, FilePlus2, FolderGit2, Plus, Search } from "lucide-react";
import { useState } from "react";
import { Form, Link, data, useNavigate, useRevalidator, useSubmit } from "react-router";

import type { Route } from "./+types/home";
import { docsRequest, useDocsData } from "../../../components/docs/actions";
import { RepoDocsDialog } from "../../../components/docs/code";
import { PageCard, SectionTitle, SpaceCard, TemplateCard } from "../../../components/docs/parts";
import { DocsSidebar } from "../../../components/docs/sidebar";
import { ButtonLink, EmptyState, ErrorText } from "../../../components/ui";
import { SelectField } from "../../../components/ui/select";
import { canDo } from "../../../lib/docs";
import { page } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";
import { BUILTIN_TEMPLATE_IDS } from "../../../components/docs/templates";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Docs · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ home: DocsHome | null; templates: DocTemplate[] }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const slug = params.owner.toLowerCase();
  const project = new URL(request.url).searchParams.get("project");
  const [home, templates] = await Promise.all([
    docs
      .home(slug, viewer, { project })
      .then((r) => (r.ok ? r.value : null))
      .catch(() => null),
    docs
      .templates(slug, viewer)
      .then((r) => (r.ok ? r.value : []))
      .catch(() => []),
  ]);
  return { home, templates };
}

/** Docs' home: what changed lately, your pages, the spaces, templates to start from; filtered by project. */
export default function DocsHomePage({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const { home, templates } = loaderData;
  const layout = useDocsData();
  const navigate = useNavigate();
  const submit = useSubmit();
  const [error, setError] = useState<string | null>(null);
  const [addingRepo, setAddingRepo] = useState(false);
  const { revalidate } = useRevalidator();
  const general = layout?.sidebar?.spaces.find((s) => s.is_default) ?? layout?.sidebar?.spaces.find((s) => canDo(s.viewer_role, "edit"));
  const spacesById = new Map((home?.spaces ?? []).map((s) => [s.id, s]));
  // What a new page is being started from ("" for a blank one), while it is.
  const [starting, setStarting] = useState<string | null>(null);
  const create = async (template?: string) => {
    if (!general || starting != null) return;
    setStarting(template ?? "");
    setError(null);
    const made = await docsRequest<{ path: string }>(slug, "create_page", { page: { space_id: general.id, template_id: template ?? null } });
    if (made.ok) {
      await navigate(made.value.path);
      return;
    }
    setStarting(null);
    setError(made.error.message);
  };
  if (!home) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState title="Docs didn't answer">Try again in a moment.</EmptyState>
      </div>
    );
  }
  const featured = templates.filter((t) => BUILTIN_TEMPLATE_IDS.includes(t.id)).slice(0, 4);
  return (
    <div className="mx-auto max-w-5xl">
      {/* On a phone, the spaces and pages first: the sidebar as the page. */}
      <div className="-mx-4 -mt-6 mb-6 border-b border-line md:hidden">
        <div className="h-[60dvh]">
          <DocsSidebar slug={slug} />
        </div>
      </div>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-accent">
            <BookOpen size={18} />
            <span className="text-xs font-medium tracking-wide uppercase">Docs</span>
          </div>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">What your workspace knows</h1>
          <p className="mt-1 max-w-xl text-sm text-muted">Specs, runbooks, decisions and onboarding, written together with your agents. Everything here is searchable, and agents read it before they work.</p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => setAddingRepo(true)} className="inline-flex h-9 items-center gap-1.5 rounded-md border border-line px-3 text-sm text-fg/80 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg">
            <FolderGit2 size={15} /> Show a project&apos;s docs
          </button>
          <ButtonLink to={`/${slug}/-/docs/new`} variant="quiet">
            <Plus size={15} /> New space
          </ButtonLink>
          {general && (
            <button
              type="button"
              disabled={starting != null}
              aria-busy={starting === ""}
              onClick={() => create()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-accent px-3 text-sm font-medium text-bg transition-colors hover:bg-accent-hover disabled:opacity-60"
            >
              <FilePlus2 size={15} /> {starting === "" ? "Starting…" : "New page"}
            </button>
          )}
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <Form method="get" action={`/${slug}/-/docs/search`} className="flex h-9 min-w-0 grow items-center gap-2 rounded-md border border-line bg-surface px-3 focus-within:border-accent/60 sm:max-w-md">
          <Search size={15} className="text-faint" aria-hidden="true" />
          <input name="q" placeholder="Search every page you can read" aria-label="Search docs" className="min-w-0 grow bg-transparent text-sm outline-none placeholder:text-faint" />
          {home.project && <input type="hidden" name="project" value={home.project} />}
        </Form>
        {home.projects.length > 0 && (
          <Form method="get" id="docs-project">
            <SelectField
              name="project"
              aria-label="Filter by project"
              value={home.project ?? ""}
              afterChange={() => submit(document.getElementById("docs-project") as HTMLFormElement)}
              options={[{ value: "", label: "All projects" }, ...home.projects.map((p) => ({ value: p, label: p }))]}
              className="h-9 min-w-48"
            />
          </Form>
        )}
      </div>

      {home.stale.length > 0 && (
        <section className="mt-8">
          <SectionTitle
            action={
              <Link to={`/${slug}/-/docs/stale`} className="text-xs text-muted hover:text-fg">
                All of them
              </Link>
            }
          >
            <span className="inline-flex items-center gap-1.5">
              <AlertTriangle size={13} className="text-warn" /> Possibly out of date
            </span>
          </SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {home.stale.map((p) => (
              <PageCard key={p.id} page={p} space={spacesById.get(p.space_id)} />
            ))}
          </div>
        </section>
      )}

      <section className="mt-8">
        <SectionTitle>{home.project ? `Recently edited · ${home.project}` : "Recently edited"}</SectionTitle>
        {home.recent.length ? (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {home.recent.map((p) => (
              <PageCard key={p.id} page={p} space={spacesById.get(p.space_id)} />
            ))}
          </div>
        ) : (
          <EmptyState title={home.project ? "No pages about this project yet" : "No pages yet"}>
            {home.project ? "Link a space or a page to this project from its settings." : "Start one from a template below, or with New page."}
          </EmptyState>
        )}
      </section>

      {home.mine.length > 0 && (
        <section className="mt-10">
          <SectionTitle>Your pages</SectionTitle>
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line bg-surface">
            {home.mine.map((p) => (
              <li key={p.id}>
                <Link to={p.path} prefetch="intent" className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors hover:bg-raised">
                  <span className="w-5 text-center">{p.icon ?? "📄"}</span>
                  <span className="min-w-0 grow truncate">{p.title || "Untitled"}</span>
                  <span className="hidden text-xs text-faint sm:inline">{spacesById.get(p.space_id)?.name}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-10">
        <SectionTitle
          action={
            <Link to={`/${slug}/-/docs/new`} className="text-xs text-muted hover:text-fg">
              New space
            </Link>
          }
        >
          Spaces
        </SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {home.spaces.map((s) => (
            <SpaceCard key={s.id} slug={slug} space={s} />
          ))}
        </div>
      </section>

      <RepoDocsDialog slug={slug} open={addingRepo} onOpenChange={setAddingRepo} shown={(layout?.sidebar?.repos ?? []).map((r) => r.repo.toLowerCase())} onAdded={() => void revalidate()} />

      {general && featured.length > 0 && (
        <section className="mt-10 mb-6">
          <SectionTitle
            action={
              <Link to={`/${slug}/-/docs/templates`} className="text-xs text-muted hover:text-fg">
                All templates
              </Link>
            }
          >
            Start from a template
          </SectionTitle>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {featured.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                action={
                  <button
                    type="button"
                    disabled={starting != null}
                    aria-busy={starting === t.id}
                    onClick={() => create(t.id)}
                    className="text-xs font-medium text-accent hover:underline disabled:text-faint disabled:no-underline"
                  >
                    {starting === t.id ? "Starting…" : `Use in ${general.name}`}
                  </button>
                }
              />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
