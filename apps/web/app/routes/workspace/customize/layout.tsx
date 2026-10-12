/**
 * Customize (docs.g1t.sh/guides/customize/): what shapes how a workspace's
 * agents work, in three tabs, Skills, Connectors and Plugins, each with
 * what the workspace has (Yours) and what it can add (Discover), from the
 * open plugin ecosystem as it is. Owners add; anyone else asks, and the
 * agents service keeps the request. It is part of Apps, not a mode of its
 * own: the Apps page and ⌘K lead here, and the Marketplace's old addresses
 * redirect.
 *
 * This layout holds the heading, the tabs, the Yours | Discover switch and
 * the search (both kept in the address), the owners' Add menu, and the
 * viewer's requests, which every tab reads to say what is waiting.
 */
import { Blocks, FileUp, Inbox, PenLine, Plug, Plus, Search, Sparkles, Store } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Link, NavLink, Outlet, data, useLocation, useRouteLoaderData, useSearchParams } from "react-router";

import type { InstallRequests } from "@g1t/contracts";
import { CUSTOMIZE, CUSTOMIZE_SECTIONS, type CustomizeSection, customizePath } from "@g1t/contracts/customize";

import type { Route } from "./+types/layout";
import { useDialogFetcher } from "../../../components/agents/dialogs";
import { skillsPath } from "../../../components/agents/skills";
import { AddMarketplaceDialog } from "../../../components/customize";
import { ButtonLink } from "../../../components/ui";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "../../../components/ui/dropdown-menu";
import { Input } from "../../../components/ui/input";
import { TabStrip } from "../../../components/ui/tab-strip";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { connectorNewPath, nextParams, openRequests, readQuery, readView, tabOf } from "../../../lib/customize";
import { page } from "../../../lib/meta";
import { workspaceAgents } from "../../../lib/services.server";
import { requireUser, roleIn } from "../../../lib/session.server";

export { shouldRevalidate } from "../../../lib/customize-revalidate";

export function meta({ params, ...args }: Route.MetaArgs) {
  return page(args, { title: `Customize · ${params.owner} · g1t` });
}

export type CustomizeData = {
  slug: string;
  name: string;
  owner: boolean;
  username: string;
  /** The viewer's requests (an owner's: everyone's); null when the agents service did not answer. */
  requests: InstallRequests | null;
};

export async function loader({ params, context, request }: Route.LoaderArgs): Promise<CustomizeData> {
  const viewer = requireUser(context, request);
  const slug = params.owner.toLowerCase();
  const role = roleIn(viewer, slug);
  if (!role) throw data(null, { status: 404 });
  const membership = viewer.workspaces?.find((m) => m.slug === slug);
  const requests = await workspaceAgents
    .installRequests(slug, viewer)
    .then((result) => (result.ok ? result.value : null))
    .catch(() => null);
  return { slug, name: membership?.name?.trim() || slug, owner: role === "owner", username: viewer.username, requests };
}

/** Customize's own data, from any of its pages. */
export function useCustomize(): CustomizeData {
  return useRouteLoaderData("routes/workspace/customize/layout") as CustomizeData;
}

const ICONS: Record<CustomizeSection, ReactNode> = { skills: <Sparkles size={14} />, connectors: <Plug size={14} />, plugins: <Blocks size={14} /> };

export default function CustomizeLayout({ loaderData }: Route.ComponentProps) {
  const { slug, name, owner, requests } = loaderData;
  const waiting = requests ? openRequests(requests.requests).length : 0;
  const { pathname } = useLocation();
  const [params] = useSearchParams();
  const view = readView(params);
  const tab = tabOf(pathname);
  return (
    <main className="mx-auto max-w-6xl px-4 py-8 sm:px-8 sm:py-10">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Customize</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted">
            What shapes how {name}&apos;s agents work: the skills they know, the connectors they reach, and plugins from any marketplace in the open plugin format.{" "}
            {owner ? "As an owner, you add them for everyone." : "Owners add them; ask one for what you need, and they'll hear about it."}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <ButtonLink to={customizePath("marketplaces", slug)} variant="ghost" size="sm" prefetch="intent">
            <Store size={14} />
            Marketplaces
          </ButtonLink>
          <ButtonLink to={customizePath("requests", slug)} variant="ghost" size="sm" prefetch="intent">
            <Inbox size={14} />
            {owner ? "Requests" : "Your requests"}
            {waiting > 0 && <Badge tone="warn">{waiting}</Badge>}
          </ButtonLink>
          {owner && <AddMenu slug={slug} />}
        </div>
      </div>

      <TabStrip label="Customize" className="mt-6 gap-1 border-b border-line">
        {CUSTOMIZE_SECTIONS.map((section) => {
          const to = customizePath(section, slug);
          return (
            <NavLink
              key={section}
              to={view === "discover" ? `${to}?view=discover` : to}
              prefetch="intent"
              data-active={pathname === to || pathname.startsWith(`${to}/`)}
              className={({ isActive }) =>
                `-mb-px flex items-center gap-2 border-b-2 px-3 pb-3 text-sm whitespace-nowrap transition-colors ${isActive ? "border-accent font-medium text-fg" : "border-transparent text-muted hover:text-fg"}`
              }
            >
              {ICONS[section]}
              {CUSTOMIZE[section].title}
            </NavLink>
          );
        })}
      </TabStrip>

      {tab && <Toolbar tab={tab} />}

      <div className={tab ? "mt-6" : "mt-8"}>
        <Outlet />
      </div>
    </main>
  );
}

/** Yours | Discover and the search, each kept in the address so a view can be shared. */
function Toolbar({ tab }: { tab: CustomizeSection }) {
  const [params, setParams] = useSearchParams();
  const view = readView(params);
  const [typed, setTyped] = useState(readQuery(params));
  const id = useId();
  const go = (changes: Record<string, string | null>) => setParams(nextParams(params, changes), { replace: true, preventScrollReset: true });
  return (
    <div className="mt-5 flex flex-wrap items-center gap-3">
      <ToggleGroup
        type="single"
        variant="outline"
        value={view}
        aria-label="What to show"
        onValueChange={(next) => {
          if (next && next !== view) go({ view: next });
        }}
      >
        <ToggleGroupItem value="yours">Yours</ToggleGroupItem>
        <ToggleGroupItem value="discover">Discover</ToggleGroupItem>
      </ToggleGroup>
      <div className="relative min-w-0 grow basis-60 sm:max-w-sm">
        <label htmlFor={`${id}-search`} className="sr-only">
          Search {CUSTOMIZE[tab].title.toLowerCase()}
        </label>
        <Search size={15} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" aria-hidden />
        <Input
          id={`${id}-search`}
          type="search"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            go({ q: event.target.value.trim() || null });
          }}
          placeholder={`Search ${CUSTOMIZE[tab].title.toLowerCase()}`}
          autoComplete="off"
          className="pl-9"
        />
      </div>
    </div>
  );
}

/** The owners' Add menu: a skill of their own, a connector by address, or a marketplace to read plugins from. */
function AddMenu({ slug }: { slug: string }) {
  const marketplace = useDialogFetcher("add-marketplace");
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="accent" size="sm">
            <Plus size={14} />
            Add
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem asChild>
            <Link to={skillsPath(slug, undefined, "/new")}>
              <PenLine />
              Write a skill
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to={skillsPath(slug, undefined, "/import")}>
              <FileUp />
              Import a skill
            </Link>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem asChild>
            <Link to={connectorNewPath(slug)}>
              <Plug />
              Add a connector
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => marketplace.setOpen(true)}>
            <Store />
            Add a marketplace
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AddMarketplaceDialog slug={slug} dialog={marketplace} />
    </>
  );
}
