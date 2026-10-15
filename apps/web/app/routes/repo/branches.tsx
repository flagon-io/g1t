import { Search, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Form, Link, redirect, useNavigate } from "react-router";

import type { Route } from "./+types/branches";
import type { ActiveBranch } from "../../components/branches";
import {
  type BranchActionData,
  type BranchListContext,
  type BranchRowData,
  BranchTable,
  NewBranchDialog,
  ProtectCallout,
} from "../../components/branch-list";
import { EmptyState } from "../../components/ui";
import { Alert } from "../../components/ui/alert";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "../../components/ui/tabs";
import { refusal, requireRepo } from "../../lib/access.server";
import { type BranchTab, branchSections, driftScale } from "../../lib/branches";
import { notFound } from "../../lib/not-found.server";
import { branchSegment, branchesPath, movedTab } from "../../lib/tab-paths";
import { readBranches } from "../../lib/branches.server";
import { repoPages } from "../../lib/repo-live";
import { useRepoLive } from "../../lib/use-repo-live";
import { commitChecksFor } from "../../lib/commit-checks.server";
import { page } from "../../lib/meta";
import { deployments, repos, work } from "../../lib/services.server";
import { assertSameOrigin, requireUser, unwrap } from "../../lib/session.server";

/** The most branches read for one page; past that, search narrows them. */
const BRANCHES_READ = 60;

const TAB_NAMES: Record<BranchTab, string> = { overview: "Overview", yours: "Yours", active: "Active", stale: "Stale", all: "All" };

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Branches · ${params.owner}/${params.repo} · g1t` });
}

export async function loader({ params, context, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  // Its tabs are paths: `?tab=stale`, the address before, is `/branches/stale`.
  const moved = movedTab(url, (asked) => branchesPath(`/${params.owner}/${params.repo}`, asked));
  if (moved) throw redirect(moved, 301);
  const tab: BranchTab | null = branchSegment(params.tab);
  if (!tab) throw notFound("page");
  if (params.tab != null && params.tab !== tab) throw redirect(`${branchesPath(`/${params.owner}/${params.repo}`, tab)}${url.search}`);
  const { viewer, repo, access } = await requireRepo(context, params, "read");
  const path = { namespace: params.owner, name: params.repo };
  const query = url.searchParams.get("q")?.trim().toLowerCase() || null;
  const soft = <T,>(promise: Promise<T>): Promise<T | null> => promise.catch(() => null);
  // Admins are told when the default branch has no rules at all.
  const canProtect = access.can.manage_protection && !repo.archivedAt;
  const [list, open, closed, deploys, rules] = await Promise.all([
    repos.branches(path, viewer),
    soft(work.listPulls(path, viewer, "open")),
    // Merged and closed ones, for branches with none open.
    soft(work.listPulls(path, viewer, "closed")),
    // Previews are for people with a role here; everyone else sees none.
    soft(deployments.list({ workspace: params.owner, slug: params.repo }, viewer)),
    canProtect && !repo.protected ? soft(work.effectiveRules(path, repo.defaultBranch, viewer)) : Promise.resolve(null),
  ]);
  // The merge queue's own branches (g1t-queue/<entry>) are its working
  // copies, not anyone's branch to look at.
  const all = unwrap(list).filter((branch) => !branch.name.startsWith("g1t-queue/"));
  const matching = query ? all.filter((branch) => branch.name === repo.defaultBranch || branch.name.toLowerCase().includes(query)) : all;
  const read = await readBranches(
    path,
    viewer,
    {
      defaultBranch: repo.defaultBranch,
      branches: matching,
      pulls: [...(open?.ok ? open.value : []), ...(closed?.ok ? closed.value : [])],
      previews: deploys?.ok ? deploys.value.live.filter((app) => app.kind === "preview") : [],
    },
    BRANCHES_READ,
  );
  const mainHead = all.find((branch) => branch.name === repo.defaultBranch)?.hash ?? "";
  // Each branch head's checks, in one call, streamed in beside it.
  const checks = commitChecksFor(path, viewer, [mainHead, ...read.shown.map((branch) => branch.head)]);
  const main: ActiveBranch = { name: repo.defaultBranch, head: mainHead, commit: read.head, drift: null, pull: null, preview: null };
  const canChange = access.can.push && !repo.archivedAt;
  return {
    tab,
    query,
    main,
    branches: read.shown,
    // Every branch but the default, and how many matched the search.
    total: all.length - 1,
    matched: read.total,
    unread: Math.max(0, read.total - read.shown.length),
    names: [repo.defaultBranch, ...all.map((branch) => branch.name).filter((name) => name !== repo.defaultBranch)],
    checks,
    username: viewer?.username ?? null,
    now: Date.now(),
    can: {
      push: canChange,
      renameDefault: canChange && access.can.administer,
      viewRules: access.insider && access.can.manage_protection,
    },
    // No rules hold for it, and it is not protected the older way.
    unprotected: rules?.ok === true && rules.value.rulesets.length === 0,
  };
}

export async function action({ request, params, context }: Route.ActionArgs): Promise<BranchActionData> {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const form = await request.formData();
  const text = (key: string) => String(form.get(key) ?? "").trim();
  const intent = text("intent");
  const branch = text("branch");
  // Making, deleting and renaming branches is pushing; the service also
  // asks for Admin to rename the default branch, and holds the rules.
  const refused = await refusal(context, params, "push");
  if (refused) return { intent, branch, error: refused };
  const path = { namespace: params.owner, name: params.repo };
  switch (intent) {
    case "create":
    case "restore": {
      // A restore makes the branch again at the commit it pointed to.
      const made = await repos.createBranch(user, path, branch, intent === "restore" ? text("head") : text("from"));
      return made.ok ? { intent, branch: made.value.name, hash: made.value.hash } : { intent, branch, error: made.error.message };
    }
    case "delete": {
      const removed = await repos.removeBranch(user, path, branch, text("head") || undefined);
      return removed.ok ? { intent, branch, hash: removed.value.hash } : { intent, branch, error: removed.error.message };
    }
    case "rename": {
      const renamed = await repos.renameBranch(user, path, branch, text("to"));
      return renamed.ok ? { intent, branch: text("to") } : { intent, branch, error: renamed.error.message };
    }
    default:
      return { intent, error: "Nothing to do." };
  }
}

export default function Branches({ loaderData, params }: Route.ComponentProps) {
  const { tab, query, main, branches, total, matched, unread, names, checks, username, now, can, unprotected } = loaderData;
  const base = `/${params.owner}/${params.repo}`;
  const navigate = useNavigate();
  // New, moved and deleted branches show as they happen (lib/use-repo-live.ts).
  useRepoLive({ match: repoPages.refs() });
  // Branches deleted on this visit, kept to restore until the page is left.
  const [deleted, setDeleted] = useState<Record<string, ActiveBranch>>({});
  const [notice, setNotice] = useState<{ tone: "danger" | "success"; text: string } | null>(null);

  const rows = useMemo<BranchRowData[]>(() => {
    const here = new Set(branches.map((branch) => branch.name));
    const gone = Object.values(deleted)
      .filter((branch) => !here.has(branch.name))
      .map((branch) => ({ ...branch, deleted: true }));
    return [...branches, ...gone].sort((a, b) => Date.parse(b.commit?.at ?? "0") - Date.parse(a.commit?.at ?? "0"));
  }, [branches, deleted]);
  // A restored branch is back in the list: no longer kept as deleted.
  useEffect(() => {
    const here = new Set(branches.map((branch) => branch.name));
    setDeleted((kept) => (Object.keys(kept).some((name) => here.has(name)) ? Object.fromEntries(Object.entries(kept).filter(([name]) => !here.has(name))) : kept));
  }, [branches]);
  const sections = branchSections(rows, tab, { username, now });

  const context: BranchListContext = {
    base,
    main: main.name,
    checks,
    scale: driftScale(rows),
    canPush: can.push,
    canRenameDefault: can.renameDefault,
    canViewRules: can.viewRules,
    onDeleted: (branch) => {
      setNotice(null);
      setDeleted((kept) => ({ ...kept, [branch.name]: branch }));
    },
    onRestored: (name) => setNotice({ tone: "success", text: `Restored ${name}.` }),
    onError: (text) => setNotice({ tone: "danger", text }),
  };

  const tabTo = (next: string, keepQuery = true) => {
    const search = new URLSearchParams();
    if (query && keepQuery) search.set("q", query);
    const qs = search.toString();
    return `${branchesPath(base, next)}${qs ? `?${qs}` : ""}`;
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold tracking-tight">
          Branches <span className="font-normal text-faint">{total + 1}</span>
        </h2>
        {can.push && <NewBranchDialog branches={names} main={main.name} onMade={(name) => setNotice({ tone: "success", text: `Created ${name}.` })} />}
      </div>

      {unprotected && <ProtectCallout base={base} main={main.name} dismissKey={`g1t:protect-hint-dismissed:${username ?? ""}:${base.slice(1).toLowerCase()}`} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="max-w-full overflow-x-auto">
          <Tabs value={tab} onValueChange={(next) => navigate(tabTo(next))}>
            <TabsList aria-label="Which branches">
              {(Object.keys(TAB_NAMES) as BranchTab[]).map((name) => (
                <TabsTrigger key={name} value={name}>
                  {TAB_NAMES[name]}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <Form method="get" action={branchesPath(base, tab)} role="search" className="relative w-full sm:w-72">
          <Search size={14} className="pointer-events-none absolute top-1/2 left-2.5 -translate-y-1/2 text-faint" />
          <Input name="q" defaultValue={query ?? ""} placeholder="Search branches" aria-label="Search branches" className="h-8 pl-8" />
        </Form>
      </div>

      {notice && (
        <Alert tone={notice.tone} role="alert" className="flex items-start justify-between gap-3">
          <span className="min-w-0">{notice.text}</span>
          <Button type="button" variant="ghost" size="inline" aria-label="Dismiss" className="p-0.5 text-current" onClick={() => setNotice(null)}>
            <X size={14} />
          </Button>
        </Alert>
      )}

      {query && (
        <p className="text-sm text-muted">
          {matched} of {total} {total === 1 ? "branch matches" : "branches match"} “{query}”.{" "}
          <Link to={tabTo(tab, false)} className="text-fg hover:underline">
            Clear
          </Link>
        </p>
      )}

      {tab === "overview" && (
        <section aria-labelledby="branches-default" className="space-y-2">
          <h3 id="branches-default" className="text-sm font-medium text-muted">
            Default
          </h3>
          <BranchTable rows={[main]} context={context} label="Default branch" />
        </section>
      )}

      {sections.map((section) =>
        section.branches.length === 0 && tab === "overview" ? null : (
          <section key={section.tab} aria-labelledby={`branches-${section.tab}`} className="space-y-2">
            <div className="flex items-baseline justify-between gap-3">
              <h3 id={`branches-${section.tab}`} className="text-sm font-medium text-muted">
                {section.title}
                {section.note && <span className="ml-2 text-xs font-normal text-faint">{section.note}</span>}
              </h3>
              {section.more > 0 && (
                <Link to={tabTo(section.tab)} className="shrink-0 text-xs text-muted hover:text-fg">
                  View {section.more} more
                </Link>
              )}
            </div>
            {section.branches.length > 0 ? (
              <BranchTable rows={section.branches} context={context} label={section.title} />
            ) : (
              <EmptyState title={query ? "No branch matches" : `No ${section.title.toLowerCase()}`}>
                {query
                  ? "Try another part of the name."
                  : section.tab === "yours"
                    ? "Branches whose latest commit is yours show here."
                    : section.tab === "stale"
                      ? "Branches with no commits in the last 90 days show here."
                      : "Branches agents and people push show here, each with its pull request, checks and how far it has moved from the default branch."}
              </EmptyState>
            )}
          </section>
        ),
      )}

      {tab === "overview" && rows.length === 0 && (
        <EmptyState title={query ? "No branch matches" : "Only the default branch"}>
          {query
            ? "Try another part of the name."
            : "Branches agents and people push show here, each with its pull request, checks and how far it has moved from the default branch."}
        </EmptyState>
      )}

      {unread > 0 && (
        <p className="text-xs text-faint">
          {unread} more {unread === 1 ? "branch is" : "branches are"} not shown. Search to find one by name.
        </p>
      )}
    </div>
  );
}
