/**
 * The inbox, in full: the same tabs as the panel in the top bar, with what
 * was saved and what is done, a page at a time. Every inbox form posts
 * here, the panel's included.
 */
import { Bookmark, Check, Inbox as InboxIcon } from "lucide-react";
import { Link, data, useNavigate } from "react-router";

import type { Route } from "./+types/inbox";
import { InboxCard, InboxEmpty, InboxTabs, MarkAllRead } from "../components/inbox";
import { cn } from "../lib/cn";
import { inboxTab, inboxView, markFromForm, severityOf, tabCount } from "../lib/inbox";
import { page } from "../lib/meta";
import { inbox } from "../lib/services.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

const PAGE_ITEMS = 50;

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Inbox · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const url = new URL(request.url);
  const tab = inboxTab(url.searchParams.get("tab"));
  const view = inboxView(url.searchParams.get("view"));
  const before = url.searchParams.get("before");
  const [list, counts] = await Promise.all([
    inbox.list(user, { view, severity: severityOf(tab), before, limit: PAGE_ITEMS }).catch(() => null),
    inbox.counts(user.username).catch(() => null),
  ]);
  return { tab, view, before, items: list?.items ?? null, next: list?.next ?? null, counts };
}

export async function action({ request, context }: Route.ActionArgs) {
  assertSameOrigin(request);
  const user = requireUser(context, request);
  const mark = markFromForm(await request.formData(), Date.now());
  if (!mark) return data({ error: "Nothing to do." }, { status: 400 });
  try {
    await inbox.mark(user.username, mark);
    return { error: null };
  } catch {
    return data({ error: "That did not save. Try again in a moment." }, { status: 503 });
  }
}

const VIEWS = [
  { view: "inbox", label: "Inbox", icon: <InboxIcon size={14} /> },
  { view: "saved", label: "Saved", icon: <Bookmark size={14} /> },
  { view: "done", label: "Done", icon: <Check size={14} /> },
] as const;

export default function InboxPage({ loaderData }: Route.ComponentProps) {
  const { tab, view, before, items, next, counts } = loaderData;
  const navigate = useNavigate();
  const address = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged = { tab: tab === "all" ? null : tab, view: view === "inbox" ? null : view, ...changes };
    for (const [name, value] of Object.entries(merged)) if (value) params.set(name, value);
    const query = params.toString();
    return query ? `/inbox?${query}` : "/inbox";
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Inbox</h1>
          <p className="mt-1 text-sm text-muted">What needs you, and what you follow. What an agent is waiting on comes first.</p>
        </div>
        {view === "inbox" && <MarkAllRead tab={tab} disabled={tabCount(counts, tab) === 0} />}
      </div>

      <nav aria-label="Inbox views" className="mt-6 flex gap-1 border-b border-line">
        {VIEWS.map((entry) => (
          <Link
            key={entry.view}
            to={address({ view: entry.view === "inbox" ? null : entry.view, before: null })}
            aria-current={view === entry.view ? "page" : undefined}
            className={cn(
              "-mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-sm transition-colors",
              view === entry.view ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg",
            )}
          >
            {entry.icon}
            {entry.label}
          </Link>
        ))}
      </nav>

      <div className="mt-4">
        <InboxTabs tab={tab} counts={view === "inbox" ? counts : null} onChange={(next) => navigate(address({ tab: next === "all" ? null : next, before: null }))} />
      </div>

      <div className="mt-4">
        {items == null ? (
          <p className="rounded-lg border border-line px-4 py-6 text-sm text-muted">The inbox could not be loaded. Try again in a moment.</p>
        ) : items.length === 0 ? (
          <InboxEmpty tab={tab} view={view} />
        ) : (
          <ul className="space-y-2">
            {items.map((item) => (
              <InboxCard key={item.id} item={item} />
            ))}
          </ul>
        )}
      </div>

      {(before || next) && (
        <div className="mt-6 flex justify-between text-sm">
          {before ? (
            <Link to={address({ before: null })} className="text-muted hover:text-fg">
              Newest
            </Link>
          ) : (
            <span />
          )}
          {next && (
            <Link to={address({ before: next })} className="font-medium text-accent hover:underline">
              Older
            </Link>
          )}
        </div>
      )}
    </main>
  );
}
