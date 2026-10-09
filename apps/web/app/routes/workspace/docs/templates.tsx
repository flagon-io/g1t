import type { DocTemplate } from "@g1t/contracts";
import { useState } from "react";
import { data, useNavigate } from "react-router";

import type { Route } from "./+types/templates";
import { docsRequest, useDocsAction, useDocsData } from "../../../components/docs/actions";
import { SectionTitle, TemplateCard } from "../../../components/docs/parts";
import { ErrorText } from "../../../components/ui";
import { SelectField } from "../../../components/ui/select";
import { canDo } from "../../../lib/docs";
import { page } from "../../../lib/meta";
import { docs } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Templates · Docs · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<{ templates: DocTemplate[] }> {
  const viewer = requireUser(context, request);
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const found = await docs.templates(params.owner.toLowerCase(), viewer).catch(() => null);
  return { templates: found?.ok ? found.value : [] };
}

/** g1t's templates and the workspace's own; start a page from one in any space you can write in. */
export default function DocsTemplates({ loaderData, params }: Route.ComponentProps) {
  const slug = params.owner.toLowerCase();
  const layout = useDocsData();
  const navigate = useNavigate();
  const { send, error: actionError } = useDocsAction(slug);
  const writable = (layout?.sidebar?.spaces ?? []).filter((s) => canDo(s.viewer_role, "edit"));
  const [space, setSpace] = useState(writable.find((s) => s.is_default)?.id ?? writable[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  // The template a page is being started from, while it is.
  const [starting, setStarting] = useState<string | null>(null);
  const use = async (template: string) => {
    if (starting) return;
    setStarting(template);
    setError(null);
    const made = await docsRequest<{ path: string }>(slug, "create_page", { page: { space_id: space, template_id: template } });
    if (made.ok) {
      await navigate(made.value.path);
      return;
    }
    setStarting(null);
    setError(made.error.message);
  };
  const startButton = (id: string) => (
    <button
      type="button"
      disabled={!space || starting != null}
      aria-busy={starting === id}
      onClick={() => use(id)}
      className="text-xs font-medium text-accent hover:underline disabled:text-faint disabled:no-underline"
    >
      {starting === id ? "Starting…" : "Use template"}
    </button>
  );
  const builtin = loaderData.templates.filter((t) => t.builtin);
  const own = loaderData.templates.filter((t) => !t.builtin);
  return (
    <div className="mx-auto max-w-5xl">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Templates</h1>
          <p className="mt-1 text-sm text-muted">Start a page with its structure already there. Save any page as a template from its ⋯ menu.</p>
        </div>
        {writable.length > 0 && (
          <label className="flex items-center gap-2 text-sm text-muted">
            New pages go in
            <SelectField aria-label="Space" value={space} onValueChange={setSpace} options={writable.map((s) => ({ value: s.id, label: s.name }))} className="h-9 min-w-40" />
          </label>
        )}
      </div>
      {(error || actionError) && (
        <div className="mt-3">
          <ErrorText>{error ?? actionError}</ErrorText>
        </div>
      )}
      <section className="mt-8">
        <SectionTitle>From g1t</SectionTitle>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {builtin.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              action={startButton(t.id)}
            />
          ))}
        </div>
      </section>
      <section className="mt-10">
        <SectionTitle>Your workspace&apos;s</SectionTitle>
        {own.length === 0 ? (
          <p className="text-sm text-muted">None yet. Open a page, then choose Save as template from its ⋯ menu.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {own.map((t) => (
              <TemplateCard
                key={t.id}
                template={t}
                action={
                  <>
                    {startButton(t.id)}
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
    </div>
  );
}
