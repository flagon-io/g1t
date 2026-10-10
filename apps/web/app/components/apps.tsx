import { Bell, Building2, Code2, LayoutGrid, Lock, MessagesSquare, Pin, Search, Shapes, Sparkles, Store, House, Users } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link, useFetcher, useFetchers } from "react-router";

import { ConnectorMark } from "./connectors";
import { TierBadge } from "./marketplace";
import { Skeleton } from "./ui/skeleton";
import { type BuiltinApp, type InstalledAppData, type PinnableApp, appPinFromForm, installedAppOf, withPin } from "../lib/apps";
import { cn } from "../lib/cn";
import { Hint } from "./ui/hint";

/** Each built-in app's icon, at the size asked for. */
export function appIcon(key: BuiltinApp, size = 18): ReactNode {
  const icons: Record<BuiltinApp, ReactNode> = {
    home: <House size={size} />,
    chat: <MessagesSquare size={size} />,
    notifications: <Bell size={size} />,
    agents: <Sparkles size={size} />,
    code: <Code2 size={size} />,
    artifacts: <Shapes size={size} />,
    people: <Users size={size} />,
    workspace: <Building2 size={size} />,
  };
  return icons[key];
}

/** An installed app's mark: its connector's, until extensions bring their own. */
export function InstalledMark({ app, size = 22 }: { app: { connector: InstalledAppData["connector"] }; size?: number }) {
  return <ConnectorMark view={{ id: app.connector.id, name: app.connector.name, provider: app.connector.provider ?? null }} size={size} />;
}

/** A pinned app as the dock draws it, from its key alone; null when the key names nothing installable. */
export function pinnedApp(key: PinnableApp, slug: string): { key: string; name: string; to: string; icon: (size: number) => ReactNode } | null {
  const app = installedAppOf(key);
  if (!app) return null;
  return { key, name: app.name, to: app.path(slug), icon: (size) => <InstalledMark app={app} size={size} /> };
}

/** Every pin form shares this key, so the dock, the launcher and the Apps page see one change. */
const PIN_FETCHER = "app-pin";

/**
 * Someone's pins in the workspace `slug`, as saved (`saved`, from the
 * root's data), with any pin or unpin on its way already applied, so the
 * dock changes the moment a pin is pressed. `toggle` pins or unpins.
 */
export function useAppPins(slug: string, saved: PinnableApp[]) {
  const fetcher = useFetcher({ key: PIN_FETCHER });
  const fetchers = useFetchers();
  const pins = useMemo(() => {
    let pins = saved;
    for (const pending of fetchers) {
      if (pending.key !== PIN_FETCHER || !pending.formData) continue;
      const change = appPinFromForm(pending.formData);
      if (change) pins = withPin(pins, change.app, change.pinned);
    }
    return pins;
  }, [saved, fetchers]);
  const toggle = (app: PinnableApp) => {
    const form = new FormData();
    form.set("intent", pins.includes(app) ? "unpin" : "pin");
    form.set("app", app);
    fetcher.submit(form, { method: "post", action: `/${slug}/-/apps` });
  };
  return { pins, toggle };
}

/**
 * One installed app: its mark and name, opening it; and a pin that shows
 * on hover or focus and stays lit while it is pinned. An app the person
 * can't use says Request access instead, and has no pin.
 */
export function AppTile({
  app,
  pinned,
  onToggle,
  onOpen,
  card = false,
}: {
  app: InstalledAppData;
  pinned: boolean;
  onToggle: (app: PinnableApp) => void;
  onOpen?: () => void;
  /** On the Apps page: a card with what the app is. */
  card?: boolean;
}) {
  const body = (
    <>
      <span className="relative flex shrink-0">
        <InstalledMark app={app} size={40} />
        {!app.usable && (
          <span className="absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full bg-surface text-faint ring-1 ring-line">
            <Lock size={9} />
          </span>
        )}
      </span>
      {card ? (
        <span className="min-w-0">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-sm font-medium text-fg">{app.name}</span>
            <TierBadge tier={app.tier} focusable={false} />
          </span>
          <span className="block truncate text-xs text-muted">{app.usable ? app.about : "Request access"}</span>
        </span>
      ) : (
        <span className="flex w-full min-w-0 flex-col items-center gap-1">
          <span className="block w-full truncate text-xs font-medium text-fg-soft">{app.name}</span>
          {app.usable ? <TierBadge tier={app.tier} focusable={false} className="px-1 text-[0.5625rem] leading-3.5" /> : <span className="block truncate text-[0.625rem] text-accent">Request access</span>}
        </span>
      )}
    </>
  );
  const linkClass = cn(
    "flex w-full rounded-xl text-center outline-none focus-visible:ring-2 focus-visible:ring-accent",
    card ? "items-center gap-3 p-3.5 pr-11 text-left" : "flex-col items-center gap-1.5 px-1 pt-3 pb-2.5",
  );
  return (
    <div
      className={cn(
        "group/tile relative rounded-xl transition-colors",
        card ? "border border-line bg-surface hover:border-line-strong" : "hover:bg-raised focus-within:bg-raised",
      )}
    >
      {/* An app the person can't use leads (`href`) to where they ask for it. */}
      <Link to={app.href} prefetch="intent" onClick={onOpen} className={linkClass}>
        {body}
      </Link>
      {app.usable && (
        <Hint label={pinned ? "Unpin from your dock" : "Pin to your dock"}>
          <button
            type="button"
            aria-label={pinned ? `Unpin ${app.name} from your dock` : `Pin ${app.name} to your dock`}
            aria-pressed={pinned}
            onClick={() => onToggle(app.key)}
            className={cn(
              "absolute flex size-6 items-center justify-center rounded-md outline-none transition-opacity hover:bg-line focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-accent [@media(hover:none)]:opacity-100",
              card ? "top-1/2 right-2.5 -translate-y-1/2" : "top-1 right-1",
              pinned ? "text-accent opacity-100" : "text-faint opacity-0 group-hover/tile:opacity-100 hover:text-fg",
            )}
          >
            <Pin size={13} className={pinned ? "fill-current" : undefined} />
          </button>
        </Hint>
      )}
    </div>
  );
}

/** When nothing is installed: what Apps are, and the way to the Marketplace. */
export function NoApps({ slug, onOpen, compact = false }: { slug: string; onOpen?: () => void; compact?: boolean }) {
  return (
    <div className={cn("flex flex-col items-center text-center", compact ? "px-4 py-6" : "rounded-xl border border-dashed border-line px-6 py-12")}>
      <span className="flex size-10 items-center justify-center rounded-xl bg-raised text-muted ring-1 ring-line">
        <Store size={18} />
      </span>
      <p className="mt-3 text-sm font-medium">No apps installed yet</p>
      <p className="mt-1 max-w-xs text-[0.8125rem] text-muted">Apps come from the Marketplace: integrations your workspace connects, and extensions later. Each one you can use shows here, to pin to your dock.</p>
      <Link to={`/${slug}/-/marketplace`} onClick={onOpen} className="mt-4 inline-flex h-8 items-center gap-1.5 rounded-md bg-fg px-3 text-[0.8125rem] font-medium text-bg hover:bg-fg-hover">
        <Store size={14} />
        Browse the Marketplace
      </Link>
    </div>
  );
}

/**
 * The Apps launcher's body: a search, every app the workspace installed
 * that the person can use (read from the Apps page as it opens), and the
 * way to all of them and to the Marketplace.
 */
export function AppsLauncher({ slug, pins, onToggle, onClose }: { slug: string; pins: PinnableApp[]; onToggle: (app: PinnableApp) => void; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const loader = useFetcher<{ apps: InstalledAppData[] | null }>();
  useEffect(() => {
    if (loader.state === "idle" && !loader.data) loader.load(`/${slug}/-/apps`);
    // Once per opening: the launcher's body mounts when it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);
  const installed = loader.data?.apps;
  const wanted = query.trim().toLowerCase();
  const apps = (installed ?? []).filter((app) => !wanted || app.name.toLowerCase().includes(wanted) || app.about.toLowerCase().includes(wanted));
  return (
    <div className="flex flex-col gap-2">
      {installed == null && loader.data ? (
        <p className="px-2 py-6 text-center text-sm text-muted">Apps can't be listed right now. Try again in a moment.</p>
      ) : installed == null ? (
        <div className="grid grid-cols-4 gap-1 p-1 max-sm:grid-cols-3" aria-busy="true" aria-label="Loading apps">
          {Array.from({ length: 4 }, (_, n) => (
            <div key={n} className="flex flex-col items-center gap-2 px-1 pt-3 pb-2.5">
              <Skeleton className="size-10 rounded-xl" />
              <Skeleton className="h-2.5 w-12" />
            </div>
          ))}
        </div>
      ) : installed.length === 0 ? (
        <NoApps slug={slug} onOpen={onClose} compact />
      ) : (
        <>
          <label className="flex h-9 items-center gap-2 rounded-lg border border-line bg-bg px-2.5 text-sm focus-within:border-line-strong">
            <Search size={15} className="shrink-0 text-faint" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find an app"
              aria-label="Find an app"
              autoComplete="off"
              className="min-w-0 grow bg-transparent outline-none placeholder:text-faint"
            />
          </label>
          {apps.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted">No installed app matches.</p>
          ) : (
            <div className="grid max-h-[min(23.5rem,60dvh)] grid-cols-4 gap-1 overflow-y-auto max-sm:grid-cols-3">
              {apps.map((app) => (
                <AppTile key={app.key} app={app} pinned={pins.includes(app.key)} onToggle={onToggle} onOpen={onClose} />
              ))}
            </div>
          )}
        </>
      )}
      <div className="flex items-center justify-between border-t border-line pt-2">
        <Link
          to={`/${slug}/-/apps`}
          onClick={onClose}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] text-muted transition-colors hover:bg-line hover:text-fg"
        >
          <LayoutGrid size={14} />
          All apps
        </Link>
        <Link
          to={`/${slug}/-/marketplace`}
          onClick={onClose}
          className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] text-muted transition-colors hover:bg-line hover:text-fg"
        >
          <Store size={14} />
          Marketplace
        </Link>
      </div>
    </div>
  );
}
