import { ChartColumn, Plus, Search, ShieldCheck } from "lucide-react";
import { Form, Link, useSearchParams } from "react-router";

import type { Route } from "./+types/settings-rules";
import { page } from "../../lib/meta";
import { RepoSettingsHeading } from "../../components/repo-settings-heading";
import { EffectiveRulesView, InsightsView, RulesetList } from "../../components/rules";
import { ButtonLink } from "../../components/ui";
import { Input } from "../../components/ui/input";
import { work } from "../../lib/services.server";
import { getViewer, unwrap } from "../../lib/session.server";
import { requireInsider } from "../../lib/access.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Rules · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // Maintain and up, as for branch protection.
  const { repo, access } = await requireInsider(context, params, "manage_protection");
  const url = new URL(request.url);
  const tab = url.searchParams.get("tab") === "insights" ? "insights" : "rulesets";
  const path = { namespace: params.owner, name: params.repo };
  const tagged = url.searchParams.get("tag");
  const branch = (tagged ?? url.searchParams.get("branch") ?? repo.defaultBranch).trim() || repo.defaultBranch;
  const [rulesets, effective, evaluations] = await Promise.all([
    work.listRulesets({ repo: path }, viewer, true),
    tab === "rulesets" ? work.effectiveRules(path, branch, viewer, tagged ? "tag" : "branch") : Promise.resolve(null),
    tab === "insights"
      ? work.ruleEvaluations({ repo: path }, viewer, {
          before: url.searchParams.get("before") ?? undefined,
          problems_only: url.searchParams.get("problems") === "1",
        })
      : Promise.resolve(null),
  ]);
  return {
    tab,
    branch,
    target: tagged ? ("tag" as const) : ("branch" as const),
    defaultBranch: repo.defaultBranch,
    rulesets: unwrap(rulesets),
    effective: effective?.ok ? effective.value : null,
    evaluations: evaluations?.ok ? evaluations.value : null,
    editable: access.can.manage_protection && !repo.archivedAt,
  };
}

export default function RepoRules({ loaderData, params }: Route.ComponentProps) {
  const { tab, branch, target, defaultBranch, rulesets, effective, evaluations, editable } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const [search] = useSearchParams();
  const own = rulesets.filter((ruleset) => ruleset.level === "repository");
  const inherited = rulesets.filter((ruleset) => ruleset.level === "workspace");
  const hrefFor = (id: string, level: "repository" | "workspace") => (level === "workspace" ? `/${params.owner}/-/rules/${id}` : `${base}/settings/rules/${id}`);
  const tabLink = (name: "rulesets" | "insights") => {
    const next = new URLSearchParams(search);
    next.delete("before");
    if (name === "rulesets") next.delete("tab");
    else next.set("tab", name);
    const query = next.toString();
    return `${base}/settings/rules${query ? `?${query}` : ""}`;
  };
  return (
    <div className="max-w-4xl">
      <RepoSettingsHeading base={base} />
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
        <div className="space-y-10">
          <section>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="font-medium">This repository's rulesets</h2>
                <p className="mt-1 text-sm text-muted">They stack with the workspace's: every rule of each that targets a branch holds there.</p>
              </div>
              {editable && (
                <ButtonLink to={`${base}/settings/rules/new`}>
                  <Plus size={15} /> New ruleset
                </ButtonLink>
              )}
            </div>
            <RulesetList
              rulesets={own}
              level="repository"
              hrefFor={(ruleset) => hrefFor(ruleset.id, ruleset.level)}
              empty={
                <>
                  No rulesets yet. Anyone who may push can push to any branch, and pull requests merge without approvals or checks.
                  {editable && (
                    <>
                      {" "}
                      <Link to={`${base}/settings/rules/new`} className="text-fg underline underline-offset-2">
                        Create one
                      </Link>{" "}
                      to protect {defaultBranch}.
                    </>
                  )}
                </>
              }
            />
          </section>
          {inherited.length > 0 && (
            <section>
              <h2 className="font-medium">From the workspace</h2>
              <p className="mt-1 mb-3 text-sm text-muted">Set for every repository of {params.owner} they select. Owners change them in the workspace's settings.</p>
              <RulesetList rulesets={inherited} level="repository" hrefFor={(ruleset) => hrefFor(ruleset.id, ruleset.level)} empty={null} />
            </section>
          )}
          <section>
            <h2 className="font-medium">What holds for a branch</h2>
            <p className="mt-1 mb-3 text-sm text-muted">Every rule of every ruleset that targets it, active ones first.</p>
            <Form method="get" className="mb-4 flex flex-wrap items-center gap-2">
              <div className="relative w-72 max-w-full">
                <Search size={14} className="absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
                <Input name={target === "tag" ? "tag" : "branch"} defaultValue={branch} aria-label="Branch" placeholder={defaultBranch} className="pl-8 font-mono text-[0.8125rem]" />
              </div>
              <button type="submit" className="rounded-md border border-line px-3 py-1.5 text-sm text-muted hover:border-line-strong hover:text-fg">
                Show rules
              </button>
            </Form>
            {effective ? (
              <EffectiveRulesView effective={effective} hrefFor={hrefFor} />
            ) : (
              <p className="text-sm text-muted">The rules for that name could not be read.</p>
            )}
          </section>
        </div>
      ) : evaluations ? (
        <InsightsView page={evaluations} olderHref={evaluations.next ? `${base}/settings/rules?tab=insights&before=${encodeURIComponent(evaluations.next)}` : null} />
      ) : (
        <p className="text-sm text-muted">Insights could not be read just now.</p>
      )}
    </div>
  );
}
