/**
 * Notifications, in full: the same tabs as the panel in the top bar, with
 * what was saved and what is done, a page at a time. Its sidebar
 * (components/shell.tsx) chooses between those and narrows them by why you
 * were told; below 1024px, where the sidebar is a drawer, the page has
 * them too. Every notifications form posts here, the panel's included.
 */
import { Bell, Bookmark, Check } from "lucide-react";
import { Link, data, useNavigate } from "react-router";

import type { Route } from "./+types/notifications";
import { InboxCard, InboxEmpty, InboxTabs, MarkAllRead } from "../components/inbox";
import { Card } from "../components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select";
import { cn } from "../lib/cn";
import { REASON_FILTERS, inboxReason, inboxTab, inboxView, markFromForm, severityOf, tabCount } from "../lib/inbox";
import { page } from "../lib/meta";
import { inbox } from "../lib/services.server";
import { assertSameOrigin, requireUser } from "../lib/session.server";

const PAGE_ITEMS = 50;

export function meta(args: Route.MetaArgs) {
  return page(args, { title: "Notifications · g1t" });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const user = requireUser(context, request);
  const url = new URL(request.url);
  const tab = inboxTab(url.searchParams.get("tab"));
  const view = inboxView(url.searchParams.get("view"));
  const reason = inboxReason(url.searchParams.get("reason"));
  const before = url.searchParams.get("before");
  const [list, counts] = await Promise.all([
    inbox.list(user, { view, severity: severityOf(tab), reason, before, limit: PAGE_ITEMS }).catch(() => null),
    inbox.counts(user.username).catch(() => null),
  ]);
  return { tab, view, reason, before, items: list?.items ?? null, next: list?.next ?? null, counts };
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
  { view: "inbox", label: "Everything", icon: <Bell size={14} /> },
  { view: "saved", label: "Saved", icon: <Bookmark size={14} /> },
  { view: "done", label: "Done", icon: <Check size={14} /> },
] as const;

export default function NotificationsPage({ loaderData }: Route.ComponentProps) {
  const { tab, view, reason, before, items, next, counts } = loaderData;
  const navigate = useNavigate();
  const address = (changes: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const merged = { tab: tab === "all" ? null : tab, view: view === "inbox" ? null : view, reason, ...changes };
    for (const [name, value] of Object.entries(merged)) if (value) params.set(name, value);
    const query = params.toString();
    return query ? `/notifications?${query}` : "/notifications";
  };

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Notifications</h1>
          <p className="mt-1 text-sm text-muted">What needs you, and what you follow. What is waiting on you comes first.</p>
        </div>
        {view === "inbox" && <MarkAllRead tab={tab} disabled={tabCount(counts, tab) === 0} />}
      </div>

      <nav aria-label="Notifications views" className="mt-6 flex gap-1 border-b border-line lg:hidden">
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

      <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="min-w-0 grow">
          <InboxTabs tab={tab} counts={view === "inbox" ? counts : null} onChange={(next) => navigate(address({ tab: next === "all" ? null : next, before: null }))} />
        </div>
        {/* Why you were told: a review asked of you, a mention, what you watch. */}
        <Select value={reason ?? "any"} onValueChange={(value) => navigate(address({ reason: value === "any" ? null : value, before: null }))}>
          <SelectTrigger size="sm" aria-label="Reason" className="sm:w-44 lg:hidden">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {REASON_FILTERS.map((entry) => (
              <SelectItem key={entry.reason ?? "any"} value={entry.reason ?? "any"}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="mt-4">
        {items == null ? (
          <Card asChild tone="plain" radius="lg" className="px-4 py-6 text-sm text-muted">
            <p>Notifications could not be loaded. Try again in a moment.</p>
          </Card>
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
