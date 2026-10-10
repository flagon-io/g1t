/**
 * The Marketplace: what a workspace can add, which anyone in it may
 * browse. Owners add agents and integrations; everyone else asks an owner,
 * and the agents service keeps the request (lib/marketplace.ts). It is not
 * in the dock: the Apps page and the launcher lead here, as does ⌘K.
 *
 * This layout holds the heading, the tabs and the viewer's requests, which
 * every tab reads to say what is waiting.
 */
import { Blocks, Bot, Inbox, Plug, Sparkles } from "lucide-react";
import { Link, NavLink, Outlet, data, useLocation, useRouteLoaderData } from "react-router";

import type { ExtensionInstall, InstallRequests } from "@g1t/contracts";

import type { Route } from "./+types/layout";
import { TabStrip } from "../../../components/ui/tab-strip";
import { marketplacePath, openRequests } from "../../../lib/marketplace";
import { page } from "../../../lib/meta";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Marketplace · ${params.owner} · g1t` });
}

export type MarketplaceData = {
  slug: string;
  name: string;
  owner: boolean;
  username: string;
  /** The viewer's requests (an owner's: everyone's); null when the agents service did not answer. */
  requests: InstallRequests | null;
  /** The extensions installed in the workspace; empty when the agents service did not answer. */
  installs: ExtensionInstall[];
};

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<MarketplaceData> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const membership = viewer.workspaces?.find((m) => m.slug === slug);
  const [requests, installs] = await Promise.all([
    workspaceAgents
      .installRequests(slug, viewer)
      .then((result) => (result.ok ? result.value : null))
      .catch(() => null),
    workspaceAgents
      .extensionInstalls(slug, viewer)
      .then((result) => (result.ok ? result.value : []))
      .catch(() => []),
  ]);
  return { slug, name: membership?.name?.trim() || slug, owner: role === "owner", username: viewer.username, requests, installs };
}

/** The Marketplace's own data, from any of its pages. */
export function useMarketplace(): MarketplaceData {
  return useRouteLoaderData("routes/workspace/marketplace/layout") as MarketplaceData;
}

export default function MarketplaceLayout({ loaderData }: Route.ComponentProps) {
  const { slug, name, owner, requests } = loaderData;
  const waiting = requests ? openRequests(requests.requests).length : 0;
  const { pathname } = useLocation();
  const tabs = [
    { to: marketplacePath(slug), label: "Discover", icon: <Sparkles size={14} />, end: true },
    { to: marketplacePath(slug, "agents"), label: "Agents", icon: <Bot size={14} /> },
    { to: marketplacePath(slug, "integrations"), label: "Integrations", icon: <Plug size={14} /> },
    { to: marketplacePath(slug, "extensions"), label: "Extensions", icon: <Blocks size={14} /> },
    { to: marketplacePath(slug, "requests"), label: owner ? "Requests" : "Your requests", icon: <Inbox size={14} />, count: waiting },
  ];
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Marketplace</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            Agents, integrations and extensions {name} can add.{" "}
            {owner ? "As an owner, you add them for everyone." : "Owners add them; ask one for what you need, and they'll hear about it."}
          </p>
        </div>
        <Link to={`/${slug}/-/apps`} className="text-sm text-muted hover:text-fg">
          Your apps
        </Link>
      </div>
      <TabStrip label="Marketplace" className="mt-6 gap-1 border-b border-line">
        {tabs.map((tab) => (
          <NavLink
            key={tab.to}
            to={tab.to}
            end={tab.end}
            prefetch="intent"
            data-active={tab.end ? pathname === tab.to : pathname.startsWith(tab.to)}
            className={({ isActive }) =>
              `-mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-sm whitespace-nowrap transition-colors ${
                isActive ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"
              }`
            }
          >
            {tab.icon}
            {tab.label}
            {tab.count != null && tab.count > 0 && <span className="rounded-full bg-warn/15 px-1.5 py-px text-xs text-warn tabular-nums">{tab.count}</span>}
          </NavLink>
        ))}
      </TabStrip>
      <div className="mt-8">
        <Outlet />
      </div>
    </main>
  );
}
