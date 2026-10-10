import {
  BarChart3,
  Bell,
  Boxes,
  Brain,
  Building2,
  Code2,
  History,
  LayoutGrid,
  MessagesSquare,
  Network,
  Package,
  Pin,
  Plug,
  Search,
  Shapes,
  ShieldCheck,
  Sparkles,
  Store,
  Sun,
  Users,
  UsersRound,
  Waypoints,
} from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { Link, useFetcher, useFetchers } from "react-router";

import { type AppInfo, type AppKey, type PinnableApp, appPinFromForm, appsFor, withPin } from "../lib/apps";
import { cn } from "../lib/cn";
import { Hint } from "./ui/hint";

/** Each app's icon, at the size asked for. */
export function appIcon(key: AppKey, size = 18): ReactNode {
  const icons: Record<AppKey, ReactNode> = {
    today: <Sun size={size} />,
    chat: <MessagesSquare size={size} />,
    notifications: <Bell size={size} />,
    agents: <Sparkles size={size} />,
    code: <Code2 size={size} />,
    artifacts: <Shapes size={size} />,
    people: <Users size={size} />,
    workspace: <Building2 size={size} />,
    projects: <Boxes size={size} />,
    packages: <Package size={size} />,
    security: <ShieldCheck size={size} />,
    context: <Network size={size} />,
    memory: <Brain size={size} />,
    teams: <UsersRound size={size} />,
    usage: <BarChart3 size={size} />,
    gateway: <Waypoints size={size} />,
    integrations: <Plug size={size} />,
    audit: <History size={size} />,
  };
  return icons[key];
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
 * One app: its icon and name, opening it; and, for an app people pin, a
 * pin that shows on hover or focus and stays lit while it is pinned.
 */
export function AppTile({
  app,
  slug,
  pinned,
  onToggle,
  onOpen,
  card = false,
}: {
  app: AppInfo;
  slug: string;
  pinned: boolean;
  onToggle: (app: PinnableApp) => void;
  onOpen?: () => void;
  /** On the Apps page: a card with what the app is. */
  card?: boolean;
}) {
  return (
    <div
      className={cn(
        "group/tile relative rounded-xl transition-colors",
        card ? "border border-line bg-surface hover:border-line-strong" : "hover:bg-raised focus-within:bg-raised",
      )}
    >
      <Link
        to={app.path(slug)}
        prefetch="intent"
        onClick={onOpen}
        className={cn(
          "flex w-full rounded-xl text-center outline-none focus-visible:ring-2 focus-visible:ring-accent",
          card ? "items-center gap-3 p-3.5 pr-11 text-left" : "flex-col items-center gap-1.5 px-1 pt-3 pb-2.5",
        )}
      >
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-raised text-fg ring-1 ring-line group-hover/tile:ring-line-strong">
          {appIcon(app.key, 19)}
        </span>
        {card ? (
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-fg">{app.name}</span>
            <span className="block truncate text-xs text-muted">{app.about}</span>
          </span>
        ) : (
          <span className="w-full truncate text-xs font-medium text-fg-soft">{app.name}</span>
        )}
      </Link>
      {!app.builtin && (
        <Hint label={pinned ? "Unpin from your dock" : "Pin to your dock"}>
          <button
            type="button"
            aria-label={pinned ? `Unpin ${app.name} from your dock` : `Pin ${app.name} to your dock`}
            aria-pressed={pinned}
            onClick={() => onToggle(app.key as PinnableApp)}
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

/**
 * The Apps launcher's body: a search, every app in the workspace the
 * person can use, and the way to all of them and to the Marketplace.
 */
export function AppsLauncher({
  slug,
  code,
  pins,
  onToggle,
  onClose,
}: {
  slug: string;
  code: boolean;
  pins: PinnableApp[];
  onToggle: (app: PinnableApp) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const wanted = query.trim().toLowerCase();
  const apps = appsFor(code).filter((app) => !wanted || app.name.toLowerCase().includes(wanted) || app.about.toLowerCase().includes(wanted));
  return (
    <div className="flex flex-col gap-2">
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
        <p className="px-2 py-6 text-center text-sm text-muted">No app matches.</p>
      ) : (
        <div className="grid max-h-[min(23.5rem,60dvh)] grid-cols-4 gap-1 overflow-y-auto max-sm:grid-cols-3">
          {apps.map((app) => (
            <AppTile key={app.key} app={app} slug={slug} pinned={pins.includes(app.key as PinnableApp)} onToggle={onToggle} onOpen={onClose} />
          ))}
        </div>
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
        <Hint label="There is no marketplace yet." disabled>
          <button type="button" disabled className="flex h-8 items-center gap-1.5 rounded-md px-2 text-[0.8125rem] text-faint">
            <Store size={14} />
            Marketplace
            <span className="rounded-full bg-line px-1.5 text-[0.625rem] font-medium text-muted">Coming</span>
          </button>
        </Hint>
      </div>
    </div>
  );
}
