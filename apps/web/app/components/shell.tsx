import {
  Activity,
  GanttChart,
  KanbanSquare,
  Package,
  Sparkles,
  BarChart3,
  BookMarked,
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Ellipsis,
  CircleDot,
  Code2,
  Compass,
  CreditCard,
  GitPullRequest,
  History,
  House,
  Fingerprint,
  Gauge,
  KeyRound,
  LifeBuoy,
  Box,
  LayoutGrid,
  ListTree,
  Lock,
  LogIn,
  LogOut,
  Menu,
  Plus,
  Search,
  Plug,
  Settings,
  Users,
  Webhook,
  Globe,
  GitBranch,
  PlayCircle,
  Bot,
  Brain,
  Network,
  ShieldCheck,
  Rocket,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, NavLink, useLocation, useNavigation, useRouteLoaderData, useSubmit } from "react-router";

import type { Abilities, Membership, Spike, User } from "@g1t/contracts";

import { CommandPalette, type PaletteCommand, usePaletteShortcut } from "./command-palette";
import { LegalRow } from "./footer";
import { Logo, Mark } from "./logo";
import { Avatar, notACredential } from "./ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { type RoadmapItem, roadmapIn } from "../lib/roadmap";
import { SETTINGS_CAPABILITY, type ViewerAccess, seesSettings } from "../lib/access";
import { VISITOR_LINKS, projectPages } from "../lib/chrome";
import { withNext } from "../lib/next";
import { useSignUpCopy } from "../lib/registration";

/**
 * What the sidebar needs, worked out by the root loader. For a visitor who
 * is not signed in there is no workspace, no projects and no usage: only
 * the project being looked at, if they can see it.
 */
export type ShellData = {
  /** The workspace the sidebar is about: the one being looked at, or their first. */
  workspace: Membership | null;
  /** Its projects, by name: `name` is the slug in their address. */
  repos: { namespace: string; name: string; title?: string; isPrivate: boolean }[];
  /** Repositories shared with them in workspaces they do not belong to. */
  shared?: { namespace: string; name: string; isPrivate: boolean }[];
  /** The project being looked at, if any, whoever owns it. */
  repo: {
    namespace: string;
    name: string;
    member: boolean;
    issues: number;
    pulls: number;
  } | null;
  /** Where the workspace stands against its usage limit, if billing is on. */
  limit: {
    exposureMicros: number;
    ceilingMicros: number | null;
    state: "ok" | "warning" | "stopped";
    comped: boolean;
  } | null;
  /** Whether g1t charges nothing for now, while it is being built out. */
  free?: boolean;
  /** What its agents have cost since the start of the month. */
  /** This month's usage: charged, or at cost while g1t is free. */
  monthUsageMicros: number | null;
  /** Whether new compute is paused (a spend spike or a hold), and whether the viewer can answer it. */
  compute?: { paused: string | null; spike: Spike | null; owner: boolean } | null;
};

function SidebarLink({
  to,
  icon,
  end,
  count,
  also,
  drill,
  children,
}: {
  to: string;
  icon: ReactNode;
  end?: boolean;
  count?: number;
  /** Other path prefixes under which this link is the current one. */
  also?: string | string[];
  /** It opens a list of its own: a chevron says so, always or on hover. */
  drill?: boolean | "hover";
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  return (
    <NavLink
      to={to}
      end={end}
      prefetch="intent"
      className={({ isActive, isPending }) => {
        const current =
          isActive || [also ?? []].flat().some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
        return `group flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
          current
            ? "bg-raised font-medium text-fg"
            : isPending
              ? "bg-raised/60 text-fg"
              : "text-muted hover:bg-raised/60 hover:text-fg"
        }`;
      }}
    >
      <span className="shrink-0 text-faint group-hover:text-muted">{icon}</span>
      <span className="min-w-0 grow truncate">{children}</span>
      {count != null && count > 0 && (
        <span className="rounded bg-line px-1.5 text-[0.6875rem] tabular-nums text-muted">
          {count}
        </span>
      )}
      {drill && (
        <ChevronRight
          size={14}
          aria-hidden="true"
          className={`-mr-0.5 shrink-0 text-faint transition-opacity ${drill === "hover" ? "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100" : ""}`}
        />
      )}
    </NavLink>
  );
}

/**
 * Something a project will have, shown where it will live so people can
 * see where g1t is going. Not a link: nothing is behind it yet.
 */
function SidebarSoon({ icon, children, about }: { icon: ReactNode; children: ReactNode; about: string }) {
  return (
    <div
      title={about}
      aria-disabled="true"
      className="flex h-8 cursor-default items-center gap-2.5 rounded-md px-2 text-[0.8125rem] text-faint"
    >
      <span className="shrink-0 opacity-70">{icon}</span>
      <span className="grow truncate">{children}</span>
      <span className="rounded-full px-1.5 py-px text-[0.625rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">
        Soon
      </span>
    </div>
  );
}

/**
 * A page that is coming, as a link to its roadmap page: faint, with Soon,
 * and marked current on any of its section's Soon pages.
 */
function SidebarSoonLink({
  to,
  also,
  icon,
  about,
  children,
}: {
  to: string;
  also?: string[];
  icon: ReactNode;
  about: string;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  return (
    <NavLink
      to={to}
      title={about}
      prefetch="intent"
      className={({ isActive }) => {
        const current = isActive || (also ?? []).some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
        return `group flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
          current ? "bg-raised font-medium text-fg" : "text-faint hover:bg-raised/60 hover:text-muted"
        }`;
      }}
    >
      <span className="shrink-0 opacity-80">{icon}</span>
      <span className="min-w-0 grow truncate">{children}</span>
      <span className="rounded-full px-1.5 py-px text-[0.625rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">
        Soon
      </span>
    </NavLink>
  );
}

/** Icons for what spans projects. */
const WORKSPACE_ICONS: Record<string, ReactNode> = {
  board: <KanbanSquare size={15} />,
  roadmap: <GanttChart size={15} />,
  packages: <Package size={15} />,
  fleet: <Bot size={15} />,
};

/** The Soon pages of a section, as paths, so its link is current on them. */
function soonPaths(base: string, section: RoadmapItem["section"]): string[] {
  return roadmapIn(section).map((item) => `${base}/soon/${item.key}`);
}

function SidebarGroup({
  title,
  action,
  className = "",
  children,
}: {
  title: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className}>
      <div className="mb-1 flex h-6 items-center justify-between px-2">
        <h2 className="text-xs font-medium text-faint">{title}</h2>
        {action}
      </div>
      <div className="space-y-px">{children}</div>
    </section>
  );
}

/** What a workspace is called where people read it: its display name, else its slug. */
function displayName(membership: Membership): string {
  return membership.name?.trim() || membership.slug;
}

function WorkspaceSwitcher({ user, shell }: { user: User; shell: ShellData }) {
  const workspace = shell.workspace;
  const current = workspace?.slug;
  const label = workspace ? displayName(workspace) : "Choose a workspace";
  return (
    <DropdownMenu>
      {/* The name goes to the workspace; only the arrows switch it. The
          name gets all the room there is, and the whole of it on hover. */}
      <Link
        to={current ? `/${current}` : "/workspaces/new"}
        title={workspace ? `${label} · g1t.sh/${workspace.slug}` : undefined}
        className="flex h-9 min-w-0 grow items-center gap-2 rounded-md px-2 transition-colors hover:bg-raised"
      >
        {workspace ? (
          <Avatar name={workspace.slug} image={workspace.avatar} size={20} square />
        ) : (
          <span className="size-5 shrink-0 rounded-md border border-dashed border-line-strong" />
        )}
        <span className="min-w-0 truncate text-[0.8125rem] font-medium">{label}</span>
      </Link>
      <DropdownMenuTrigger
        aria-label="Switch workspace"
        className="flex h-9 w-7 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg"
      >
        <ChevronsUpDown size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {(user.workspaces ?? []).map((membership) => (
          <DropdownMenuItem asChild key={membership.slug}>
            <Link to={`/${membership.slug}`} title={displayName(membership)}>
              <Avatar name={membership.slug} image={membership.avatar} size={24} square />
              <span className="flex min-w-0 grow flex-col leading-tight">
                <span className="truncate">{displayName(membership)}</span>
                <span className="truncate font-mono text-[0.6875rem] text-faint">{membership.slug}</span>
              </span>
              <span className="shrink-0 text-[0.6875rem] text-faint capitalize">{membership.role}</span>
              {membership.slug === current ? (
                <Check className="shrink-0 text-accent" />
              ) : (
                <span className="size-4 shrink-0" aria-hidden="true" />
              )}
            </Link>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/workspaces/new">
            <Plus />
            New workspace
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function AccountMenu({ user }: { user: User }) {
  const submit = useSubmit();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-raised data-[state=open]:bg-raised">
        <Avatar name={user.username} image={user.avatar} size={22} />
        <span className="min-w-0 grow truncate text-[0.8125rem] font-medium">{user.username}</span>
        <Ellipsis size={15} className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-64">
        <DropdownMenuLabel>
          Signed in as <span className="font-mono font-medium text-fg">{user.username}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings />
            Your settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href="https://docs.g1t.sh/">
            <BookOpen />
            Documentation
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {/* Submitted from here: the menu closes on select, and a button
            that has left the page cannot submit a form. */}
        <DropdownMenuItem onSelect={() => submit(null, { method: "post", action: "/logout" })}>
          <LogOut />
          Sign out
        </DropdownMenuItem>
        {/* The site footer's row, slim: the app has no footer of its own.
            Rendered only while the menu is open, so status is fetched then. */}
        <DropdownMenuSeparator />
        <div className="px-1.5 pt-1 pb-1.5">
          <LegalRow user={user} compact />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A workspace's settings pages, which the sidebar drills into: who belongs,
 * what it pays, and its record. What it builds and runs with (secrets,
 * integrations, webhooks, guardrails) sits in the main list.
 */
const SETTINGS_PAGE = /^\/([^/]+)\/-\/(settings|people|repositories|tokens|billing|audit)(\/|$)/;
/** A project's settings pages, which the project's menu drills into. */
const REPO_SETTINGS_PAGE = /^\/([^/]+)\/([^/-][^/]*)\/settings(\/|$)/;

/**
 * The sidebar's lists are a stack, the way a phone pushes a screen: one
 * drilled into slides in from the right over the full width, while the one
 * it covers drifts a quarter of the way left and fades, both on one long
 * ease-out, the fade quicker than the move so the two never blur together.
 * Going back reverses it.
 */
const LAYER =
  "absolute inset-0 [transition:translate_380ms_cubic-bezier(0.32,0.72,0,1),opacity_220ms_ease-out] will-change-[translate,opacity] motion-reduce:transition-none";
/** One list, filling its layer. */
const PANEL = "h-full overflow-y-auto px-2 pb-4";

/** One list in the stack: what it is, and its rows. */
type Level = { key: string; node: ReactNode };

/** True once the page has hydrated, so what the server drew never animates in. */
function useHydrated(): boolean {
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  return hydrated;
}

/**
 * Drilling in and out of the sidebar's lists. `trail` is the way from the
 * main list to the one shown, worked out from the address, so a link
 * straight to a settings page opens the sidebar already drilled in, and
 * leaving it comes back out. Lists deeper than the one shown stay in
 * place, off to the right, so going back slides them away rather than
 * dropping them. Moving to a list at the same depth (a workspace's settings
 * to a project) fades the new one in where it is.
 */
function Drill({ trail }: { trail: Level[] }) {
  const depth = trail.length - 1;
  const hydrated = useHydrated();
  const stack = useRef<Level[]>(trail);
  const before = stack.current;
  const within = trail.every((level, index) => before[index]?.key === level.key);
  stack.current = within ? [...trail, ...before.slice(trail.length)] : trail;
  const levels = stack.current;
  // What was showing last time, to tell drilling in from moving across.
  const shown = useRef({ depth, keys: levels.map((level) => level.key) });
  useEffect(() => {
    shown.current = { depth, keys: levels.map((level) => level.key) };
  });
  return (
    <div className="relative min-h-0 grow overflow-hidden">
      {levels.map((level, index) => {
        const current = index === depth;
        const place =
          index < depth
            ? "pointer-events-none -translate-x-1/4 opacity-0"
            : current
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-full opacity-0";
        // A list that was not there before arrives: from the right when
        // drilling in, in place when moving across.
        const arriving = hydrated && current && !shown.current.keys.includes(level.key);
        const enter = arriving
          ? depth > shown.current.depth
            ? "starting:translate-x-full starting:opacity-0"
            : "starting:opacity-0"
          : "";
        return (
          <div key={level.key} className={`${LAYER} ${place} ${enter}`} inert={!current} aria-hidden={!current || undefined}>
            {level.node}
          </div>
        );
      })}
    </div>
  );
}

/**
 * The row at the top of a list drilled into: the list's name, which goes
 * back out, and what it belongs to, faint at the end.
 */
function BackRow({ to, label, context }: { to: string; label: ReactNode; context?: ReactNode }) {
  return (
    <Link
      to={to}
      prefetch="intent"
      className="group mt-3 flex h-8 items-center gap-1.5 rounded-md pr-2 pl-1 text-[0.8125rem] font-medium text-fg transition-colors hover:bg-raised/60"
    >
      <ChevronLeft size={16} className="shrink-0 text-faint transition-transform group-hover:-translate-x-0.5 group-hover:text-muted" />
      <span className="min-w-0 shrink-0 truncate">{label}</span>
      {context && (
        <span className="ml-auto min-w-0 truncate pl-2 font-mono text-[0.6875rem] font-normal text-faint">{context}</span>
      )}
    </Link>
  );
}

/** A thin rule between groups of a list. */
function Rule() {
  return <div role="separator" className="mx-2 my-2.5 h-px bg-line" />;
}

/**
 * The main list: where you go, the projects, what the workspace builds and
 * runs with across them, then its usage, support and settings.
 */
function MainMenu({ user, shell }: { user: User | null; shell: ShellData }) {
  const ws = shell.workspace;
  const active = shell.repo;
  // The repository being looked at is listed even when it is someone else's.
  const listed =
    active && !shell.repos.some((repo) => repo.namespace === active.namespace && repo.name === active.name)
      ? [{ namespace: active.namespace, name: active.name, isPrivate: false }, ...shell.repos]
      : shell.repos;
  // A visitor browses: no workspace, no projects of their own.
  if (!user) {
    return (
      <nav aria-label="g1t" className={PANEL}>
        <div className="mt-3 space-y-px">
          {VISITOR_LINKS.map((link) => (
            <SidebarLink key={link.to} to={link.to} icon={link.to === "/search" ? <Search size={15} /> : <Compass size={15} />}>
              {link.label}
            </SidebarLink>
          ))}
        </div>
      </nav>
    );
  }
  return (
    <nav aria-label="g1t" className={PANEL}>
      <div className="mt-3 space-y-px">
        <SidebarLink to="/" end icon={<House size={15} />}>
          Mission control
        </SidebarLink>
        {ws && (
          <SidebarLink to={`/${ws.slug}`} end icon={<LayoutGrid size={15} />}>
            Overview
          </SidebarLink>
        )}
        <SidebarLink to="/explore" icon={<Compass size={15} />}>
          Explore
        </SidebarLink>
      </div>

      <Rule />
      <SidebarGroup
        title="Projects"
        action={
          ws && (
            <Link
              to={`/new?workspace=${ws.slug}`}
              aria-label="New project"
              className="rounded p-0.5 text-faint hover:bg-raised hover:text-fg"
            >
              <Plus size={13} />
            </Link>
          )
        }
      >
        {listed.length === 0 && <p className="px-2 py-1 text-xs text-faint">None yet.</p>}
        {listed.map((repo) => (
          <SidebarLink
            key={`${repo.namespace}/${repo.name}`}
            to={`/${repo.namespace}/${repo.name}`}
            icon={repo.isPrivate ? <Lock size={15} /> : <Box size={15} />}
            drill="hover"
          >
            {repo.namespace !== ws?.slug && <span className="font-mono text-faint">{repo.namespace}/</span>}
            {"title" in repo && repo.title ? repo.title : repo.name}
          </SidebarLink>
        ))}
      </SidebarGroup>
      {(shell.shared ?? []).length > 0 && (
        <SidebarGroup title="Shared with you" className="mt-3">
          {(shell.shared ?? []).map((repo) => (
            <SidebarLink
              key={`${repo.namespace}/${repo.name}`}
              to={`/${repo.namespace}/${repo.name}`}
              icon={repo.isPrivate ? <Lock size={15} /> : <Box size={15} />}
              drill="hover"
            >
              <span className="font-mono text-faint">{repo.namespace}/</span>
              {repo.name}
            </SidebarLink>
          ))}
        </SidebarGroup>
      )}

      {ws && (
        <>
          <Rule />
          <div className="space-y-px">
            <SidebarLink to={`/${ws.slug}/-/agents`} icon={<Bot size={15} />}>
              Agent fleet
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/context`} icon={<Network size={15} />}>
              Context
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/memory`} icon={<Brain size={15} />}>
              Memory
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/security`} icon={<ShieldCheck size={15} />}>
              Security
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/guardrails`} icon={<Gauge size={15} />}>
              Guardrails
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/secrets`} icon={<Lock size={15} />}>
              Secrets and variables
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/integrations`} icon={<Plug size={15} />}>
              Integrations
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/webhooks`} icon={<Webhook size={15} />}>
              Webhooks
            </SidebarLink>
            {roadmapIn("Workspace").map((item) => (
              <SidebarSoonLink
                key={item.key}
                to={`/${ws.slug}/-/soon/${item.key}`}
                icon={WORKSPACE_ICONS[item.key] ?? <Sparkles size={15} />}
                about={item.summary}
              >
                {item.title === "Board" ? "Boards" : item.title}
              </SidebarSoonLink>
            ))}
          </div>

          <Rule />
          <div className="space-y-px">
            <SidebarLink to={`/${ws.slug}/-/usage`} icon={<BarChart3 size={15} />}>
              Usage
            </SidebarLink>
            <SidebarLink to="/support" icon={<LifeBuoy size={15} />}>
              Support
            </SidebarLink>
            {/* Who belongs, what it pays and its record: a list of their own. */}
            <SidebarLink
              to={ws.role === "owner" ? `/${ws.slug}/-/settings` : `/${ws.slug}/-/people`}
              icon={<Settings size={15} />}
              drill
            >
              Settings
            </SidebarLink>
          </div>
        </>
      )}
    </nav>
  );
}

/** A workspace's settings, drilled into from Settings in the main list. */
function SettingsMenu({ slug, owner }: { slug: string; owner: boolean }) {
  return (
    <nav aria-label="Workspace settings" className={PANEL}>
      <BackRow to={`/${slug}`} label="Settings" context={slug} />
      <div className="mt-2 space-y-px">
        {owner && (
          <SidebarLink to={`/${slug}/-/settings`} icon={<Settings size={15} />}>
            General
          </SidebarLink>
        )}
        <SidebarLink to={`/${slug}/-/people`} icon={<Users size={15} />}>
          Members
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/repositories`} icon={<BookMarked size={15} />}>
          Repositories
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/tokens`} icon={<KeyRound size={15} />}>
          Access tokens
        </SidebarLink>
      </div>
      <Rule />
      <div className="space-y-px">
        <SidebarLink to={`/${slug}/-/billing`} icon={<CreditCard size={15} />}>
          Billing and plans
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/audit`} icon={<History size={15} />}>
          Audit log
        </SidebarLink>
      </div>
    </nav>
  );
}

/**
 * What the repository menu needs. Known from the address before the page's
 * data arrives, so the menu is right from the first frame; the counts fill
 * in once it does.
 */
type MenuRepo = {
  namespace: string;
  name: string;
  member: boolean;
  /** Whether they see its settings; from the repository's page once it loads. */
  settings?: boolean;
  /** What they may do there, once the repository's page loads. */
  can?: Abilities;
  issues?: number;
  pulls?: number;
};

function sameRepo(a: { namespace: string; name: string } | null, b: { namespace: string; name: string } | null) {
  return (
    a != null &&
    b != null &&
    a.namespace.toLowerCase() === b.namespace.toLowerCase() &&
    a.name.toLowerCase() === b.name.toLowerCase()
  );
}

/**
 * A project's own list, drilled into while you are in it: everything about
 * the project, running and its code, and nothing else, with the way back
 * out to all of them.
 */
function RepoMenu({
  repo,
  isPrivate,
  back,
}: {
  repo: MenuRepo;
  isPrivate: boolean;
  /** Where the way back leads: the workspace's projects, mission control, or Explore. */
  back: { to: string; label: string };
}) {
  const base = `/${repo.namespace}/${repo.name}`;
  // What a member sees, and what everyone who can see the project does.
  const shows = new Set(projectPages(repo.member, repo.can));
  return (
    <nav aria-label={`${repo.namespace}/${repo.name}`} className={PANEL}>
      <BackRow to={back.to} label={back.label} />
      <NavLink
        to={base}
        end
        title="Overview"
        className={({ isActive }) =>
          `mt-2 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors ${isActive ? "bg-raised" : "hover:bg-raised/60"}`
        }
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
          {isPrivate ? <Lock size={13} /> : <Box size={13} />}
        </span>
        <span className="min-w-0 truncate font-mono text-[0.8125rem]">
          <span className="text-faint">{repo.namespace}/</span>
          <span className="font-semibold text-fg">{repo.name}</span>
        </span>
      </NavLink>
      {/* A project's pages, in the order people use them. A page with more
          than one view shows them as tabs across its top. */}
      <Rule />
      <div className="space-y-px">
        <SidebarLink to={`${base}/code`} also={[`${base}/tree`, `${base}/blob`, `${base}/commits`, `${base}/commit`, ...soonPaths(base, "Code")]} icon={<Code2 size={15} />}>
          Code
        </SidebarLink>
        <SidebarLink to={`${base}/issues`} also={[`${base}/plans`, ...soonPaths(base, "Issues")]} icon={<CircleDot size={15} />} count={repo.issues}>
          Issues
        </SidebarLink>
        <SidebarLink to={`${base}/pulls`} also={[`${base}/pull`, `${base}/queue`]} icon={<GitPullRequest size={15} />} count={repo.pulls}>
          Pull requests
        </SidebarLink>
        <SidebarLink to={`${base}/agents`} also={[`${base}/sessions`, `${base}/memory`, ...soonPaths(base, "Agents")]} icon={<Bot size={15} />}>
          Agents
        </SidebarLink>
        <SidebarLink to={`${base}/actions`} icon={<PlayCircle size={15} />}>
          Workflows
        </SidebarLink>
      </div>
      <Rule />
      <div className="space-y-px">
        {shows.has("deployments") ? (
          <SidebarLink to={`${base}/deployments`} also={soonPaths(base, "Deployments")} icon={<Rocket size={15} />}>
            Deployments
          </SidebarLink>
        ) : null}
        <SidebarSoonLink to={`${base}/soon/logs`} also={soonPaths(base, "Observability")} icon={<Activity size={15} />} about="Logs, errors, uptime and analytics of the project's deployed apps.">
          Observability
        </SidebarSoonLink>
        {shows.has("security") ? (
          <SidebarLink to={`${base}/security`} also={soonPaths(base, "Security")} icon={<ShieldCheck size={15} />}>
            Security
          </SidebarLink>
        ) : null}
        <SidebarSoonLink to={`${base}/soon/delivery`} also={soonPaths(base, "Insights")} icon={<BarChart3 size={15} />} about="Delivery metrics, costs and the work agents do.">
          Insights
        </SidebarSoonLink>
      </div>
      {(repo.settings ?? shows.has("settings")) && (
        <>
          <Rule />
          <SidebarLink to={`${base}/settings`} icon={<Settings size={15} />} drill>
            Settings
          </SidebarLink>
        </>
      )}
    </nav>
  );
}

/**
 * A project's settings, drilled into from its list: what is about running
 * it, then its agents, then its code and who can reach it. The way back
 * leads to the project.
 */
function RepoSettingsMenu({ repo }: { repo: MenuRepo }) {
  const base = `/${repo.namespace}/${repo.name}`;
  // Each page shows to the roles that can use it, once the role is known.
  const shows = (page: string) => !repo.can || repo.can[SETTINGS_CAPABILITY[page] ?? "administer"];
  const running = shows("deployments");
  const agents = shows("agents") || shows("guardrails");
  return (
    <nav aria-label={`${repo.namespace}/${repo.name} settings`} className={PANEL}>
      <BackRow to={base} label="Settings" context={`${repo.namespace}/${repo.name}`} />
      {shows("") && (
        <div className="mt-2 space-y-px">
          <SidebarLink to={`${base}/settings`} end icon={<Settings size={15} />}>
            General
          </SidebarLink>
        </div>
      )}
      {running && (
        <>
          {shows("") && <Rule />}
          <div className={shows("") ? "space-y-px" : "mt-2 space-y-px"}>
            <SidebarLink to={`${base}/settings/deployments`} icon={<Rocket size={15} />}>
              Deployments
            </SidebarLink>
            <SidebarLink to={`${base}/settings/domains`} icon={<Globe size={15} />}>
              Domains
            </SidebarLink>
            <SidebarLink to={`${base}/settings/dependencies`} icon={<Network size={15} />}>
              Dependencies
            </SidebarLink>
          </div>
        </>
      )}
      {agents && (
        <>
          <Rule />
          <div className="space-y-px">
            {shows("agents") && (
              <SidebarLink to={`${base}/settings/agents`} icon={<Bot size={15} />}>
                Agents
              </SidebarLink>
            )}
            {shows("guardrails") && (
              <SidebarLink to={`${base}/settings/guardrails`} icon={<ShieldCheck size={15} />}>
                Guardrails
              </SidebarLink>
            )}
          </div>
        </>
      )}
      <Rule />
      <div className="space-y-px">
        {shows("repository") && (
          <SidebarLink to={`${base}/settings/repository`} icon={<BookMarked size={15} />}>
            Repository
          </SidebarLink>
        )}
        {shows("access") && (
          <SidebarLink to={`${base}/settings/access`} icon={<Users size={15} />}>
            Access
          </SidebarLink>
        )}
        {shows("branches") && (
          <SidebarLink to={`${base}/settings/branches`} icon={<GitBranch size={15} />}>
            Branches and merging
          </SidebarLink>
        )}
        {shows("secrets") && (
          <SidebarLink to={`${base}/settings/secrets`} icon={<Lock size={15} />}>
            Secrets and variables
          </SidebarLink>
        )}
        {shows("webhooks") && (
          <SidebarLink to={`${base}/settings/webhooks`} icon={<Webhook size={15} />}>
            Webhooks
          </SidebarLink>
        )}
      </div>
    </nav>
  );
}

/** Your own settings, as the sidebar shows them on the settings page. */
function AccountSettingsMenu() {
  const { hash } = useLocation();
  const item = (id: string, icon: ReactNode, label: string) => (
    <Link
      to={`/settings#${id}`}
      className={`group flex h-8 items-center gap-2.5 rounded-md px-2 text-[0.8125rem] transition-colors ${
        hash === `#${id}` ? "bg-raised font-medium text-fg" : "text-muted hover:bg-raised/60 hover:text-fg"
      }`}
    >
      <span className="shrink-0 text-faint group-hover:text-muted">{icon}</span>
      {label}
    </Link>
  );
  return (
    <nav aria-label="Your settings" className={PANEL}>
      <BackRow to="/" label="Your settings" />
      <div className="mt-2 space-y-px">
        {item("ssh-keys", <Fingerprint size={15} />, "SSH keys")}
        {item("tokens", <KeyRound size={15} />, "Access tokens")}
        {item("applications", <Plug size={15} />, "Connected applications")}
      </div>
    </nav>
  );
}

/**
 * Signing in and signing up, in place of the account for a visitor. Signing
 * in brings them back to the page they are on.
 */
function VisitorPanel() {
  const { pathname, search } = useLocation();
  const signUp = useSignUpCopy();
  return (
    <div className="space-y-2">
      <p className="px-1 text-xs text-muted">Sign in to open issues, review pull requests and run agents.</p>
      <div className="grid grid-cols-2 gap-2">
        <Link
          to={withNext("/login", pathname + search)}
          className="flex h-9 items-center justify-center gap-1.5 rounded-md border border-line text-[0.8125rem] font-medium text-fg/90 transition-colors hover:border-line-strong hover:bg-raised hover:text-fg"
        >
          <LogIn size={14} />
          Sign in
        </Link>
        <Link
          to={withNext("/register", pathname + search)}
          className="flex h-9 items-center justify-center rounded-md bg-fg text-[0.8125rem] font-medium text-bg transition-colors hover:bg-white"
        >
          {signUp.primary}
        </Link>
      </div>
      <nav aria-label="About g1t" className="flex flex-wrap justify-center gap-x-2 gap-y-0.5 px-1 pt-1 text-[0.6875rem] text-faint">
        <Link to="/status" className="hover:text-fg">Status</Link>
        <Link to="/support" className="hover:text-fg">Support</Link>
        <Link to="/policies" className="hover:text-fg">Policies</Link>
        <Link to="/policies/privacy" className="hover:text-fg">Privacy</Link>
        <Link to="/security" className="hover:text-fg">Security</Link>
      </nav>
    </div>
  );
}

function Sidebar({
  user,
  shell,
  onFind,
  onClose,
}: {
  user: User | null;
  shell: ShellData;
  onFind: () => void;
  /** In the sheet on a small screen: closing it, at the end of the top row. */
  onClose?: () => void;
}) {
  const ws = shell.workspace;
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  // Where the sidebar is drilled to follows the page being gone to, so it
  // moves as the link is followed, not once the page arrives.
  const target = going ?? pathname;
  const inSettings = ws != null && SETTINGS_PAGE.exec(target)?.[1]?.toLowerCase() === ws.slug;
  const inAccount = target === "/settings";
  const active = shell.repo;
  // In a repository, or on the way into one, its own list.
  const repoPath = /^\/([^/]+)\/([^/-][^/]*)(\/|$)/.exec(target);
  const reserved = new Set(["settings", "explore", "search", "new", "u", "pricing", "avatars", "workspaces", "login", "logout", "register", "verify", "forgot", "reset", "device", "oauth", "policies", "security", "support", "status", "invite", ".well-known"]);
  // An invitation to a repository is answered before its menu means anything.
  const inRepo =
    repoPath != null && !reserved.has(repoPath[1]) && repoPath[2] !== "-" && !/^\/[^/]+\/[^/]+\/invitations\/?$/.test(target);
  // A project's settings, one level further in.
  const inRepoSettings = inRepo && REPO_SETTINGS_PAGE.test(target);
  // The repository the menu is for: the one loaded if it is the one being
  // gone to, else what the address says, at once.
  const targetRepo = inRepo && repoPath ? { namespace: repoPath[1], name: repoPath[2] } : null;
  const guessed: MenuRepo | null = targetRepo
    ? sameRepo(active, targetRepo)
      ? active
      : {
          ...targetRepo,
          member: (user?.workspaces ?? []).some((m) => m.slug === targetRepo.namespace.toLowerCase()),
        }
    : null;
  // The viewer's role there, from the repository's page once it has loaded.
  const page = useRouteLoaderData("routes/repo/layout") as
    | { repo?: { namespace: string; name: string }; access?: ViewerAccess }
    | undefined;
  const menuRepo: MenuRepo | null =
    guessed && page?.access && page.repo && sameRepo(page.repo, guessed)
      ? { ...guessed, member: page.access.insider, settings: seesSettings(page.access), can: page.access.can }
      : guessed;

  // The way from the main list to the one shown.
  const trail: Level[] = [{ key: "main", node: <MainMenu user={user} shell={shell} /> }];
  if (user && inAccount) {
    trail.push({ key: "account", node: <AccountSettingsMenu /> });
  } else if (ws && inSettings) {
    trail.push({ key: `settings:${ws.slug}`, node: <SettingsMenu slug={ws.slug} owner={ws.role === "owner"} /> });
  } else if (menuRepo) {
    const key = `repo:${menuRepo.namespace}/${menuRepo.name}`.toLowerCase();
    // Out of a project: to its workspace's projects when they are yours.
    const home = (user?.workspaces ?? []).find((m) => m.slug === menuRepo.namespace.toLowerCase());
    const back = !user
      ? { to: "/explore", label: "Explore" }
      : home
        ? { to: `/${home.slug}`, label: "All projects" }
        : { to: "/", label: "Mission control" };
    trail.push({
      key,
      node: (
        <RepoMenu
          repo={menuRepo}
          isPrivate={[...shell.repos, ...(shell.shared ?? [])].some((repo) => sameRepo(repo, menuRepo) && repo.isPrivate)}
          back={back}
        />
      ),
    });
    if (inRepoSettings) trail.push({ key: `${key}:settings`, node: <RepoSettingsMenu repo={menuRepo} /> });
  }

  return (
    <div className="flex h-full flex-col">
      {/* The same height and rule as the top bar, so the two read as one line. */}
      <div className="flex h-16 shrink-0 items-center gap-1 border-b border-line pr-2 pl-2.5">
        {user ? (
          <>
            <Link to="/" aria-label="g1t home" className="shrink-0 rounded-md p-1.5 hover:bg-raised">
              <Mark className="size-6" />
            </Link>
            <span className="shrink-0 text-line-strong" aria-hidden="true">
              /
            </span>
            <WorkspaceSwitcher user={user} shell={shell} />
          </>
        ) : (
          <Link to="/" aria-label="g1t home" className="mr-auto flex rounded-md px-1.5 py-1.5 hover:bg-raised">
            <Logo />
          </Link>
        )}
        {onClose && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="flex size-9 shrink-0 items-center justify-center rounded-md text-faint hover:bg-raised hover:text-fg"
          >
            <X size={16} />
          </button>
        )}
      </div>
      <div className="px-2 pt-3">
        <button
          type="button"
          onClick={onFind}
          className="flex h-9 w-full items-center gap-2 rounded-md bg-surface px-2.5 text-[0.8125rem] text-faint ring-1 ring-line transition-colors hover:text-muted hover:ring-line-strong"
        >
          <Search size={14} />
          <span className="grow text-left">Find…</span>
          <kbd className="rounded bg-raised px-1.5 font-mono text-[0.625rem] text-muted ring-1 ring-line">⌘K</kbd>
        </button>
      </div>
      <Drill trail={trail} />
      {/* The account, or signing in, as one row at the very bottom. */}
      <div className="shrink-0 border-t border-line p-2">
        {user ? <AccountMenu user={user} /> : <VisitorPanel />}
      </div>
    </div>
  );
}

/** Words for the sections a path can end in. */
const SECTIONS: Record<string, string> = {
  issues: "Issues",
  pulls: "Pull requests",
  queue: "Merge queue",
  commits: "Commits",
  plans: "Outcomes",
  actions: "Workflows",
  soon: "Soon",
  deployments: "Deployments",
  repository: "Repository",
  access: "Access",
  invitations: "Invitation",
  repositories: "Repositories",
  branches: "Branches and merging",
  dependencies: "Dependencies",
  code: "Files",
  secrets: "Secrets and variables",
  settings: "Settings",
  people: "Members",
  tokens: "Access tokens",
  usage: "Usage",
  billing: "Billing and plans",
  integrations: "Integrations",
  webhooks: "Webhooks",
  domains: "Domains",
  guardrails: "Guardrails",
  audit: "Audit log",
  tree: "Code",
  blob: "Code",
};

/** Where the page is, as a trail of links: workspace / repository / section. */
function Breadcrumbs({ pathname }: { pathname: string }) {
  const parts = pathname.split("/").filter(Boolean);
  const reserved = ["settings", "explore", "new", "search", "workspaces", "policies", "security", "support", "status", "invite"];
  if (parts.length === 0) return <span className="text-sm font-medium">Mission control</span>;
  if (reserved.includes(parts[0]!)) {
    const words: Record<string, string> = {
      settings: "Account",
      explore: "Explore",
      new: "New project",
      search: "Search",
      workspaces: "New workspace",
      policies: "Policies",
      security: "Security",
      support: "Support",
      status: "Status",
      invite: "Invite",
    };
    return <span className="text-sm font-medium">{words[parts[0]!]}</span>;
  }
  // A person's profile, by their handle.
  if (parts[0] === "u" && parts[1]) {
    return <span className="truncate font-mono text-[0.8125rem] font-medium">@{parts[1]}</span>;
  }
  const [owner, second, third, fourth] = parts;
  const trail: { label: string; to: string; mono?: boolean }[] = [{ label: owner!, to: `/${owner}`, mono: true }];
  if (second === "-") {
    const page = `/${owner}/-/${third}`;
    if (third && SETTINGS_PAGE.test(page)) {
      trail.push({ label: "Settings", to: `/${owner}/-/settings` });
      trail.push({ label: third === "settings" ? "General" : (SECTIONS[third] ?? third), to: page });
    } else if (third) trail.push({ label: SECTIONS[third] ?? third, to: page });
  } else if (second) {
    const repo = `/${owner}/${second}`;
    trail.push({ label: second, to: repo, mono: true });
    if (third === "pull" && fourth) trail.push({ label: `Pull request #${fourth}`, to: `${repo}/pull/${fourth}` });
    else if (third === "issues" && fourth && fourth !== "new") trail.push({ label: `Issue #${fourth}`, to: `${repo}/issues/${fourth}` });
    else if (third === "commit" && fourth) trail.push({ label: fourth.slice(0, 7), to: `${repo}/commit/${fourth}`, mono: true });
    else if (third && SECTIONS[third]) {
      trail.push({ label: SECTIONS[third]!, to: `${repo}/${third}` });
      // A settings page names which one: Settings / Secrets and variables.
      if (third === "settings" && fourth && SECTIONS[fourth]) {
        trail.push({ label: SECTIONS[fourth]!, to: `${repo}/settings/${fourth}` });
      }
    }
  }
  return (
    <nav aria-label="Where you are" className="flex min-w-0 items-center gap-1.5 text-sm">
      {trail.map((crumb, index) => (
        <span key={index} className="flex min-w-0 items-center gap-1.5">
          {index > 0 && <span className="text-line-strong">/</span>}
          <Link
            to={crumb.to}
            className={`truncate rounded px-1 py-0.5 transition-colors hover:bg-raised ${
              index === trail.length - 1 ? "font-medium text-fg" : "text-muted hover:text-fg"
            } ${crumb.mono ? "font-mono text-[0.8125rem]" : ""}`}
          >
            {crumb.label}
          </Link>
        </span>
      ))}
    </nav>
  );
}

type Command = PaletteCommand;

/** Everything the palette can jump to, from what the sidebar already knows. */
function commandsFor(user: User | null, shell: ShellData, here: string, signUpLabel = "Sign up"): Command[] {
  if (!user) return visitorCommands(shell, here, signUpLabel);
  const commands: Command[] = [
    { label: "Mission control", to: "/", icon: <House size={15} /> },
    { label: "Explore repositories", to: "/explore", icon: <Compass size={15} /> },
    { label: "Search g1t", hint: "Repositories, code, issues, people", to: "/search", icon: <Search size={15} /> },
    { label: "New project", to: "/new", icon: <Plus size={15} /> },
    { label: "New workspace", to: "/workspaces/new", icon: <Plus size={15} /> },
    { label: "Your settings", to: "/settings", icon: <Settings size={15} /> },
  ];
  const repo = shell.repo;
  if (repo) {
    const base = `/${repo.namespace}/${repo.name}`;
    const name = `${repo.namespace}/${repo.name}`;
    commands.unshift(
      { label: "Overview", hint: name, to: base, icon: <LayoutGrid size={15} /> },
      { label: "Code", hint: name, to: `${base}/code`, icon: <Code2 size={15} /> },
      { label: "Issues", hint: name, to: `${base}/issues`, icon: <CircleDot size={15} /> },
      { label: "New issue", hint: name, to: `${base}/issues/new`, icon: <Plus size={15} /> },
      { label: "Pull requests", hint: name, to: `${base}/pulls`, icon: <GitPullRequest size={15} /> },
      { label: "Commits", hint: name, to: `${base}/commits`, icon: <History size={15} /> },
      ...(repo.member
        ? [
            { label: "Plan work", hint: name, to: `${base}/plans`, icon: <ListTree size={15} /> },
            { label: "Deployments", hint: name, to: `${base}/deployments`, icon: <Rocket size={15} /> },
            { label: "Secrets and variables", hint: name, to: `${base}/settings/secrets`, icon: <Lock size={15} /> },
            { label: "Project settings", hint: name, to: `${base}/settings`, icon: <Settings size={15} /> },
            { label: "Repository settings", hint: name, to: `${base}/settings/repository`, icon: <Settings size={15} /> },
          ]
        : []),
    );
  }
  for (const membership of user.workspaces ?? []) {
    commands.push(
      { label: displayName(membership), hint: `Workspace · ${membership.slug}`, to: `/${membership.slug}`, icon: <Avatar name={membership.slug} image={membership.avatar} size={15} square /> },
      { label: "Usage", hint: membership.slug, to: `/${membership.slug}/-/usage`, icon: <BarChart3 size={15} /> },
      { label: "Billing and plans", hint: `${membership.slug} · Settings`, to: `/${membership.slug}/-/billing`, icon: <CreditCard size={15} /> },
      { label: "Access tokens", hint: `${membership.slug} · Settings`, to: `/${membership.slug}/-/tokens`, icon: <KeyRound size={15} /> },
      { label: "Integrations", hint: membership.slug, to: `/${membership.slug}/-/integrations`, icon: <Plug size={15} /> },
    );
  }
  for (const listed of shell.repos) {
    commands.push({
      label: listed.title ?? listed.name,
      hint: `${listed.namespace} · Project`,
      to: `/${listed.namespace}/${listed.name}`,
      icon: <Box size={15} />,
    });
  }
  return commands;
}

/** What the palette offers a visitor: browsing, the project they are in, and signing in. */
function visitorCommands(shell: ShellData, here: string, signUpLabel: string): Command[] {
  const commands: Command[] = [];
  const repo = shell.repo;
  if (repo) {
    const base = `/${repo.namespace}/${repo.name}`;
    const name = `${repo.namespace}/${repo.name}`;
    commands.push(
      { label: "Overview", hint: name, to: base, icon: <LayoutGrid size={15} /> },
      { label: "Code", hint: name, to: `${base}/code`, icon: <Code2 size={15} /> },
      { label: "Issues", hint: name, to: `${base}/issues`, icon: <CircleDot size={15} /> },
      { label: "Pull requests", hint: name, to: `${base}/pulls`, icon: <GitPullRequest size={15} /> },
      { label: "Commits", hint: name, to: `${base}/commits`, icon: <History size={15} /> },
    );
  }
  commands.push(
    { label: "Explore", hint: "Public projects", to: "/explore", icon: <Compass size={15} /> },
    { label: "Search g1t", hint: "Repositories, code, issues, people", to: "/search", icon: <Search size={15} /> },
    { label: "Pricing", to: "/pricing", icon: <CreditCard size={15} /> },
    { label: "Documentation", to: "https://docs.g1t.sh/", icon: <BookOpen size={15} /> },
    { label: "Sign in", to: withNext("/login", here), icon: <LogIn size={15} /> },
    { label: signUpLabel, to: withNext("/register", here), icon: <Plus size={15} /> },
  );
  return commands;
}

/**
 * A bar across the top of the page while the next one loads, as GitHub
 * has: it appears at once, creeps towards the end while waiting, then fills
 * and fades when the page arrives.
 */
export function Progress() {
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const [width, setWidth] = useState(0);
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (busy) {
      setVisible(true);
      setWidth(12);
      // Slows as it goes, never quite arriving until the page does.
      const timer = setInterval(() => setWidth((now) => now + (90 - now) * 0.12), 200);
      return () => clearInterval(timer);
    }
    setWidth((now) => (now > 0 ? 100 : 0));
    const fade = setTimeout(() => setVisible(false), 250);
    const reset = setTimeout(() => setWidth(0), 550);
    return () => {
      clearTimeout(fade);
      clearTimeout(reset);
    };
  }, [busy]);
  return (
    <div
      aria-hidden="true"
      className={`pointer-events-none fixed inset-x-0 top-0 z-[60] h-[3px] transition-opacity duration-300 ${
        visible ? "opacity-100" : "opacity-0"
      }`}
    >
      <div
        className="h-full bg-accent shadow-[0_0_10px_var(--color-accent)] transition-[width] duration-200 ease-out"
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/**
 * The app: a sidebar with the workspace, its repositories and the sections
 * of the one being looked at; a slim bar with search and the account; and
 * the page. A visitor who is not signed in gets the same frame, with
 * Explore and Search in place of the workspace, and signing in in place of
 * the account.
 */
export function AppShell({
  user,
  shell,
  banner,
  children,
}: {
  user: User | null;
  shell: ShellData;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const { pathname, search } = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const here = pathname + search;
  const signUpLabel = useSignUpCopy().primary;
  const commands = useMemo(() => commandsFor(user, shell, here, signUpLabel), [user, shell, here, signUpLabel]);

  // A new page closes the drawer on small screens.
  useEffect(() => setDrawer(false), [pathname]);
  usePaletteShortcut(() => setPalette((open) => !open));

  return (
    <div className="min-h-screen">
      <Progress />
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 border-r border-line bg-[color-mix(in_srgb,var(--color-surface)_70%,var(--color-bg))] lg:block">
        <Sidebar user={user} shell={shell} onFind={() => setPalette(true)} />
      </aside>
      {drawer && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <button
            type="button"
            aria-label="Close menu"
            className="absolute inset-0 bg-black/60"
            onClick={() => setDrawer(false)}
          />
          <aside className="absolute inset-y-0 left-0 w-72 border-r border-line bg-surface">
            <Sidebar user={user} shell={shell} onFind={() => setPalette(true)} onClose={() => setDrawer(false)} />
          </aside>
        </div>
      )}

      <div className="flex min-h-screen min-w-0 flex-col lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-line bg-bg/85 px-4 backdrop-blur sm:px-6">
          <button
            type="button"
            aria-label="Open menu"
            onClick={() => setDrawer(true)}
            className="rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg lg:hidden"
          >
            <Menu size={18} />
          </button>
          <Breadcrumbs pathname={pathname} />
          <Form action="/search" role="search" className="relative ml-auto hidden w-full max-w-64 md:block">
            <Search size={14} className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint" />
            <input
              name="q"
              {...notACredential()}
              placeholder="Search g1t"
              aria-label="Search g1t"
              className="h-9 w-full rounded-md border border-line bg-surface pr-12 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
            />
            <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded bg-raised px-1.5 font-mono text-[0.625rem] text-muted ring-1 ring-line">
              ⌘K
            </kbd>
          </Form>
          <div className="ml-auto flex items-center gap-1.5 md:ml-0">
            <a
              href="https://docs.g1t.sh/"
              className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-fg sm:block"
            >
              Docs
            </a>
            {!user ? (
              // The sidebar has these too, but on a phone it is folded away.
              <Link
                to={withNext("/login", here)}
                className="flex h-9 items-center rounded-md bg-fg px-3 text-sm font-medium text-bg transition-colors hover:bg-white lg:hidden"
              >
                Sign in
              </Link>
            ) : (
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Create"
                className="flex h-9 items-center gap-1.5 rounded-md bg-fg px-3 text-sm font-medium text-bg outline-none transition-colors hover:bg-white"
              >
                <Plus size={14} />
                New
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {shell.repo && (
                  <DropdownMenuItem asChild>
                    <Link to={`/${shell.repo.namespace}/${shell.repo.name}/issues/new`}>
                      <CircleDot />
                      New issue
                    </Link>
                  </DropdownMenuItem>
                )}
                {shell.repo?.member && (
                  <DropdownMenuItem asChild>
                    <Link to={`/${shell.repo.namespace}/${shell.repo.name}/plans`}>
                      <ListTree />
                      Plan work
                    </Link>
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem asChild>
                  <Link to="/new">
                    <Box />
                    New project
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/workspaces/new">
                    <Users />
                    New workspace
                  </Link>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            )}
          </div>
        </header>
        {banner}
        <main className="min-w-0 grow">{children}</main>
      </div>
      <CommandPalette
        open={palette}
        onOpenChange={setPalette}
        commands={commands}
        repo={shell.repo ? `${shell.repo.namespace}/${shell.repo.name}` : null}
      />
    </div>
  );
}
