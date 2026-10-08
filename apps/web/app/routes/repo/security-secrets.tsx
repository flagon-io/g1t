import { Plus } from "lucide-react";
import { Link, useSearchParams } from "react-router";

import type { AlertState, DismissReason } from "@g1t/contracts";

import type { Route } from "./+types/security-secrets";
import { page } from "../../lib/meta";
import { SecretsList, StateFilter } from "../../components/security";
import { ActivationPrompt, CARD, FilterSelect, SectionHeader } from "../../components/security-suite";
import { Badge } from "../../components/ui/badge";
import { security, securitySuite } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";
import { refusal, requireInsider } from "../../lib/access.server";
import { activationPrice } from "../../lib/security-suite.server";
import { countStates, keepSecret, secretFilters, secretTypes } from "../../lib/security-suite";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Secret scanning · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context) ?? requireUser(context, request);
  const { access } = await requireInsider(context, params, "push");
  const repo = { namespace: params.owner, name: params.repo };
  const [overview, patterns, price] = await Promise.all([
    security.overview(repo, viewer),
    securitySuite.patterns(params.owner, repo, viewer),
    activationPrice(params.owner, viewer),
  ]);
  return {
    overview: unwrap(overview),
    patterns: patterns.ok ? patterns.value : { patterns: [], entitled: false },
    price,
    can: access.can,
    owner: roleIn(viewer, params.owner) === "owner",
  };
}

const REASONS = new Set(["false_positive", "used_in_tests", "revoked", "wont_fix"]);

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const repo = { namespace: params.owner, name: params.repo };
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  // Dismissing a secret lets it through push protection: Admin.
  const refused = await refusal(context, params, "manage_integrations");
  if (refused) return { ok: false, error: refused };
  if (intent === "dismiss") {
    const reason = String(form.get("reason") ?? "");
    if (!REASONS.has(reason)) return { ok: false, error: "Choose a reason." };
    const done = await security.dismiss(user, repo, id, reason as DismissReason, String(form.get("comment") ?? "").trim().slice(0, 500));
    return done.ok ? { ok: true } : { ok: false, error: done.error.message };
  }
  if (intent === "reopen") {
    const done = await security.reopen(user, repo, id);
    return done.ok ? { ok: true } : { ok: false, error: done.error.message };
  }
  return { ok: false, error: "Unknown action." };
}

export default function SecretScanning({ loaderData, params }: Route.ComponentProps) {
  const { overview, patterns, price, can, owner } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const [search, setSearch] = useSearchParams();
  const filters = secretFilters(search);
  const counts = countStates(overview.secrets.filter((secret) => keepSecret(secret, { ...filters, state: secret.state })));
  const shown = overview.secrets.filter((secret) => keepSecret(secret, filters));
  const set = (key: string, value: string | null) => {
    const next = new URLSearchParams(search);
    if (value) next.set(key, value);
    else next.delete(key);
    setSearch(next, { replace: true, preventScrollReset: true });
  };
  const own = patterns.patterns.filter((pattern) => pattern.scope === "repository");
  const inherited = patterns.patterns.filter((pattern) => pattern.scope === "workspace");
  return (
    <div className="max-w-5xl space-y-8">
      <SectionHeader
        title="Secret scanning"
        about="Pushes that add a key or a token are refused before they land; the person pushing can bypass with a reason. The default branch's history is scanned once, in the background, and again when a custom pattern is published."
      />

      <section className="space-y-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <StateFilter counts={counts} value={filters.state} onChange={(state: AlertState) => set("state", state === "open" ? null : state)} />
          <div className="flex flex-wrap gap-2">
            <FilterSelect label="Type" value={filters.type ?? "all"} options={[["all", "All types"], ...secretTypes(overview.secrets)]} onChange={(value) => set("type", value === "all" ? null : value)} />
            <FilterSelect
              label="Validity"
              value={filters.validity ?? "all"}
              options={[["all", "Any"], ["active", "Active"], ["inactive", "Inactive"], ["unknown", "Unknown"], ["unsupported", "No check"]]}
              onChange={(value) => set("validity", value === "all" ? null : value)}
            />
            <FilterSelect
              label="Bypassed"
              value={filters.bypassed == null ? "all" : String(filters.bypassed)}
              options={[["all", "Either"], ["true", "Bypassed"], ["false", "Not bypassed"]]}
              onChange={(value) => set("bypassed", value === "all" ? null : value)}
            />
          </div>
        </div>
        <SecretsList
          secrets={shown}
          state={filters.state}
          activity={overview.activity}
          base={base}
          action={`${base}/security/secret-scanning`}
          focus={search.get("finding")}
          canDismiss={can.manage_integrations}
        />
        <p className="text-xs text-faint">
          Not a real secret, such as a test fixture? Add <code>g1t:allow-secret</code> in a comment on its line, or dismiss the
          alert. Dismissing takes the Admin role and is recorded with your name and reason.
        </p>
      </section>

      <section className="space-y-3" aria-labelledby="patterns">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h3 id="patterns" className="text-base font-semibold tracking-tight">
              Custom patterns
            </h3>
            <p className="mt-1 text-sm text-muted">Formats of your own, found by push protection and history scans with the built-in ones.</p>
          </div>
          {patterns.entitled && can.manage_integrations && (
            <Link to={`${base}/security/secret-scanning/patterns`} className="inline-flex items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-sm hover:border-line-strong">
              <Plus size={14} /> New pattern
            </Link>
          )}
        </div>
        {!patterns.entitled ? (
          <ActivationPrompt workspace={params.owner} feature="Custom patterns" monthlyCents={price} isOwner={owner} />
        ) : own.length + inherited.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line px-4 py-6 text-sm text-muted">
            No custom patterns yet. Add one for your own tokens' format, try it on test strings and a dry run, then publish it.
          </p>
        ) : (
          <ul className={`${CARD} divide-y divide-line`}>
            {[...own, ...inherited].map((pattern) => (
              <li key={pattern.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
                <div className="min-w-0 grow">
                  <div className="flex flex-wrap items-center gap-2">
                    {pattern.scope === "repository" && can.manage_integrations ? (
                      <Link to={`${base}/security/secret-scanning/patterns?id=${pattern.id}`} className="text-sm font-medium hover:underline">
                        {pattern.name}
                      </Link>
                    ) : (
                      <span className="text-sm font-medium">{pattern.name}</span>
                    )}
                    <Badge tone={pattern.state === "published" ? "accent" : "neutral"}>{pattern.state === "published" ? "Published" : "Draft"}</Badge>
                    {pattern.scope === "workspace" && <Badge>From {pattern.workspace}</Badge>}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-xs text-muted">{pattern.pattern}</p>
                </div>
                <span className="shrink-0 text-xs text-faint">
                  {pattern.openAlerts} open {pattern.openAlerts === 1 ? "alert" : "alerts"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
