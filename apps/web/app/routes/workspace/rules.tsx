import { ChartColumn, Plus, ShieldCheck } from "lucide-react";
import { Link, data, useSearchParams } from "react-router";

import type { Route } from "./+types/rules";
import { page } from "../../lib/meta";
import { InsightsView, RulesetList } from "../../components/rules";
import { ButtonLink } from "../../components/ui";
import { work } from "../../lib/services.server";
import { getViewer, roleIn, unwrap } from "../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Rules · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  const role = roleIn(viewer, params.owner);
  if (!role) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "insights" ? "insights" : "rulesets";
  const owner = { workspace: params.owner };
  const [rulesets, evaluations] = await Promise.all([
    work.listRulesets(owner, viewer),
    tab === "insights" ? work.ruleEvaluations(owner, viewer, { before: url.searchParams.get("before") ?? undefined }) : Promise.resolve(null),
  ]);
  return {
    tab,
    rulesets: unwrap(rulesets),
    evaluations: evaluations?.ok ? evaluations.value : null,
    editable: role === "owner",
  };
}

export default function WorkspaceRules({ loaderData, params }: Route.ComponentProps) {
  const { tab, rulesets, evaluations, editable } = loaderData;
  const base = `/${params.owner}/-/rules`;
  const [search] = useSearchParams();
  const tabLink = (name: "rulesets" | "insights") => {
    const next = new URLSearchParams(search);
    next.delete("before");
    if (name === "rulesets") next.delete("tab");
    else next.set("tab", name);
    const query = next.toString();
    return `${base}${query ? `?${query}` : ""}`;
  };
  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6 border-b border-line pb-5">
        <h1 className="text-lg font-semibold tracking-tight">Rules</h1>
        <p className="mt-1 text-sm text-muted">
          Rulesets that hold across {params.owner}'s repositories: which branches and tags they cover, who may bypass them, and what a pull
          request needs before it merges. Each repository's own rulesets stack with these.
        </p>
      </header>
      <nav className="mb-6 flex gap-1 border-b border-line" aria-label="Rules">
        {(["rulesets", "insights"] as const).map((name) => (
          <Link
            key={name}
            to={tabLink(name)}
            aria-current={tab === name ? "page" : undefined}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === name ? "border-accent text-fg" : "border-transparent text-muted hover:text-fg"}`}
          >
            {name === "rulesets" ? <ShieldCheck size={14} /> : <ChartColumn size={14} />}
            {name === "rulesets" ? "Rulesets" : "Insights"}
          </Link>
        ))}
      </nav>
      {tab === "rulesets" ? (
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-muted">{editable ? "Owners create and change them." : "Owners create and change them; you can read them."}</p>
            {editable && (
              <ButtonLink to={`${base}/new`}>
                <Plus size={15} /> New ruleset
              </ButtonLink>
            )}
          </div>
          <RulesetList
            rulesets={rulesets}
            level="workspace"
            hrefFor={(ruleset) => `${base}/${ruleset.id}`}
            empty="No workspace rulesets yet. Each repository's own rulesets still hold."
          />
        </section>
      ) : evaluations ? (
        <InsightsView page={evaluations} showRepository olderHref={evaluations.next ? `${base}?tab=insights&before=${encodeURIComponent(evaluations.next)}` : null} />
      ) : (
        <p className="text-sm text-muted">Insights could not be read just now.</p>
      )}
    </div>
  );
}
