import { env } from "cloudflare:workers";
import { Brain, RefreshCw } from "lucide-react";
import { Link, data, useFetcher, useNavigate } from "react-router";

import { ENTITY_KINDS, type EntityKind } from "@g1t/contracts";

import type { Route } from "./+types/context";
import { page } from "../../lib/meta";
import { useRefreshWhile } from "../../lib/refresh";
import { CatalogView, ReviewQueue, ScorecardsView, SearchView, fixRule, reviewAction } from "../../components/context";
import { SubmitButton } from "../../components/ui";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { context as hub, memoryReview, work } from "../../lib/services.server";
import { assertSameOrigin, getViewer, requireUser, roleIn, unwrap } from "../../lib/session.server";

const TABS = ["catalog", "memory", "search", "scorecards"] as const;
type Tab = (typeof TABS)[number];

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Context · ${params.owner} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const viewer = getViewer(context);
  // What the workspace knows can be internal: members only.
  if (!roleIn(viewer, params.owner)) throw data(null, { status: 404 });
  const url = new URL(request.url);
  const tab: Tab = (TABS as readonly string[]).includes(url.searchParams.get("tab") ?? "") ? (url.searchParams.get("tab") as Tab) : "catalog";
  const kindParam = url.searchParams.get("kind");
  const kind = ENTITY_KINDS.includes(kindParam as EntityKind) ? (kindParam as EntityKind) : null;
  const project = url.searchParams.get("project");
  const query = url.searchParams.get("q") ?? "";
  // The first look at a workspace's context starts building it.
  const status = unwrap(await hub.status(params.owner, viewer));
  const [catalog, candidates, search, cards] = await Promise.all([
    tab === "catalog" ? hub.catalog(params.owner, viewer).then(unwrap) : null,
    tab === "memory" ? memoryReview.listCandidates(viewer, params.owner).then(unwrap) : null,
    tab === "search" && query.trim() ? hub.search(params.owner, viewer, query).then(unwrap) : null,
    tab === "scorecards" ? hub.scorecards(params.owner, viewer).then(unwrap) : null,
  ]);
  return { tab, kind, project, query, status, catalog, candidates, search, cards };
}

export async function action({ params, context, request }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const reviewed = await reviewAction(memoryReview, user, params.owner, form);
  if (reviewed) return reviewed;
  const intent = String(form.get("intent") ?? "");
  if (intent === "backfill") {
    const started = await hub.backfill(user, params.owner);
    return started.ok ? { ok: true, message: "Rebuilding the catalog and the search index." } : { ok: false, error: started.error.message };
  }
  if (intent === "fix") {
    return fixRule(
      {
        scorecards: () => hub.scorecards(params.owner, user),
        openIssue: (repo, input) => work.openIssue(user, repo, input),
        // The issue exists either way; its page shows how to put an agent on it if none could start.
        assign: (repo, number) => env.RUNNER.run(user, repo, number).catch(() => null),
      },
      String(form.get("project") ?? ""),
      String(form.get("rule") ?? ""),
    );
  }
  return { ok: false, error: "Unknown action." };
}

function Rebuild({ action, running }: { action: string; running: boolean }) {
  const fetcher = useFetcher<{ ok: boolean; error?: string; message?: string }>();
  return (
    <fetcher.Form method="post" action={action} className="flex items-center gap-2">
      <input type="hidden" name="intent" value="backfill" />
      <SubmitButton
        fetcher={fetcher}
        match={{ intent: "backfill" }}
        pending="Starting…"
        disabled={running}
        className="inline-flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-xs text-muted hover:border-line-strong hover:text-fg disabled:opacity-50"
      >
        <RefreshCw size={12} className={running ? "animate-spin" : ""} />
        {running ? "Building…" : "Rebuild"}
      </SubmitButton>
      {fetcher.data?.error && <span className="text-xs text-danger">{fetcher.data.error}</span>}
    </fetcher.Form>
  );
}

export default function WorkspaceContext({ loaderData, params }: Route.ComponentProps) {
  const { tab, kind, project, query, status, catalog, candidates, search, cards } = loaderData;
  const base = `/${params.owner}/-/context`;
  const navigate = useNavigate();
  const backfill = status.backfill;
  const running = backfill?.status === "running";
  // While it builds, the count of projects done keeps up on its own.
  useRefreshWhile(running);
  const total = Object.values(status.counts).reduce((sum, n) => sum + (n ?? 0), 0);
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <p>
          {running
            ? `Building from ${backfill.projects} project${backfill.projects === 1 ? "" : "s"}: ${backfill.done} done.`
            : `${total} entries in the catalog${backfill?.finishedAt ? `; ${backfill.candidates} memory candidates and ${backfill.kept} kept at the last rebuild` : ""}.`}
          {!status.semantic && " Search matches words only here."}
        </p>
        <Rebuild action={base} running={running} />
      </div>

      <Tabs value={tab} onValueChange={(value) => navigate(`${base}?tab=${value}`)}>
        <TabsList>
          <TabsTrigger value="catalog">Catalog</TabsTrigger>
          <TabsTrigger value="memory">Memory{candidates && candidates.length ? ` (${candidates.length})` : ""}</TabsTrigger>
          <TabsTrigger value="search">Search</TabsTrigger>
          <TabsTrigger value="scorecards">Scorecards</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "catalog" && catalog && <CatalogView catalog={catalog} kind={kind} project={project} base={base} />}

      {tab === "memory" && candidates && (
        <div className="space-y-6">
          <div className="rounded-xl border border-line bg-surface p-4 text-sm">
            <p className="flex items-center gap-2 font-medium">
              <Brain size={15} className="text-merged" />
              Memory fills itself
            </p>
            <p className="mt-1 text-muted">
              Agents say what they learned at the end of every run; corrections in reviews, merged pull requests and each
              project's docs add more. What two independent sources say, or a project's AGENTS.md and manifests state, is
              kept at once. The rest waits here: keep it, edit it, or dismiss it so it is never suggested again.
            </p>
          </div>
          <section>
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Review queue</h2>
              <Link to={`/${params.owner}/-/memory`} className="text-xs text-muted hover:text-fg">
                Kept workspace memory
              </Link>
            </div>
            <div className="mt-3">
              <ReviewQueue candidates={candidates} action={base} empty="Nothing waiting for review." />
            </div>
          </section>
        </div>
      )}

      {tab === "search" && <SearchView result={search} query={query} base={base} />}

      {tab === "scorecards" && cards && <ScorecardsView cards={cards} action={base} />}
    </div>
  );
}
