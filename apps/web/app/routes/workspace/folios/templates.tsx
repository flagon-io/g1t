import { FOLIO_KINDS, isFolioKind, type FolioKind, type FolioTemplate } from "@g1t/contracts";
import { useState } from "react";
import { Form, Link, data, useNavigation, useSearchParams } from "react-router";

import type { Route } from "./+types/templates";
import { useFoliosAction, useFoliosData } from "../../../components/folios/actions";
import { FOLIO_KIND_UI } from "../../../components/folios/kinds";
import { SectionTitle, TemplateCard } from "../../../components/folios/parts";
import { EmptyState, ErrorText } from "../../../components/ui";
import { SelectField } from "../../../components/ui/select";
import { canDo } from "../../../lib/folios";
import { page } from "../../../lib/meta";
import { folios } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Templates · Artifacts · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ templates: FolioTemplate[] | null }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await folios.templates(params.owner.toLowerCase(), viewer).catch(() => null);
  return { templates: found?.ok ? found.value : null };
}

/** g1t's templates and the workspace's own, by kind; start an artifact from one in Private or a space you can add to. */
export default function FolioTemplates({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const layout = useFoliosData();
  const { send, error } = useFoliosAction(slug);
  const [search, setSearch] = useSearchParams();
  const kind: FolioKind | null = isFolioKind(search.get("kind")) ? (search.get("kind") as FolioKind) : null;
  const writable = (layout?.sidebar?.spaces ?? []).filter((s) => canDo(s.viewer_role, "edit"));
  const [space, setSpace] = useState("private");
  const navigation = useNavigation();
  // The template an artifact is being started from, while it is.
  const starting = navigation.state !== "idle" && navigation.formAction?.includes("/-/artifacts/new/") ? String(navigation.formData?.get("template") ?? "") : null;
  const all = (loaderData.templates ?? []).filter((t) => !kind || t.kind === kind);
  const builtin = all.filter((t) => t.builtin);
  const own = all.filter((t) => !t.builtin);
  const startButton = (t: FolioTemplate) =>
    FOLIO_KIND_UI[t.kind].ready ? (
      <Form method="post" action={`/${slug}/-/artifacts/new/${t.kind}`}>
        <input type="hidden" name="template" value={t.id} />
        {space !== "private" && <input type="hidden" name="space" value={space} />}
        <button type="submit" disabled={starting != null} aria-busy={starting === t.id} className="text-xs font-medium text-accent hover:underline disabled:text-faint disabled:no-underline">
          {starting === t.id ? "Starting…" : "Use template"}
        </button>
      </Form>
    ) : (
      <span className="text-xs text-faint">Coming soon</span>
    );
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Templates</h1>
          <p className="mt-1 text-sm text-muted">Start with the structure already there. Save any artifact as a template from its ⋯ menu.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <SelectField
            aria-label="Kind"
            value={kind ?? "any"}
            onValueChange={(v) => setSearch(v === "any" ? {} : { kind: v }, { preventScrollReset: true })}
            options={[{ value: "any", label: "Every kind" }, ...FOLIO_KINDS.map((k) => ({ value: k, label: FOLIO_KIND_UI[k].label }))]}
            className="h-9 min-w-32"
          />
          <label className="flex items-center gap-2 text-sm text-muted">
            Goes in
            <SelectField aria-label="Where it goes" value={space} onValueChange={setSpace} options={[{ value: "private", label: "Private" }, ...writable.map((s) => ({ value: s.id, label: s.name }))]} className="h-9 min-w-36" />
          </label>
        </div>
      </div>
      {error && (
        <div className="mt-3">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      {loaderData.templates === null ? (
        <div className="mt-8">
          <EmptyState title="Artifacts didn't answer">Try again in a moment.</EmptyState>
        </div>
      ) : (
        <>
          <section className="mt-8">
            <SectionTitle>From g1t</SectionTitle>
            {builtin.length === 0 ? (
              <p className="text-sm text-muted">
                None for {kind ? FOLIO_KIND_UI[kind].label.toLowerCase() : "this kind"} yet. <Link to="?" className="text-accent hover:underline">See every kind</Link>
              </p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {builtin.map((t) => (
                  <TemplateCard key={t.id} template={t} action={startButton(t)} />
                ))}
              </div>
            )}
          </section>
          <section className="mt-10 mb-6">
            <SectionTitle>Your workspace&apos;s</SectionTitle>
            {own.length === 0 ? (
              <p className="text-sm text-muted">None yet. Open an artifact, then choose Save as template from its ⋯ menu.</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {own.map((t) => (
                  <TemplateCard
                    key={t.id}
                    template={t}
                    action={
                      <>
                        {startButton(t)}
                        <button type="button" onClick={() => send("delete_template", { template_id: t.id })} className="ml-auto text-xs text-faint hover:text-danger">
                          Delete
                        </button>
                      </>
                    }
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
