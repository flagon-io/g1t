import {
  ArrowLeft,
  ChevronRight,
  BarChart3,
  BookMarked,
  BookOpen,
  Check,
  ChevronsUpDown,
  Ellipsis,
  CircleDot,
  Code2,
  Compass,
  CornerDownLeft,
  CreditCard,
  GitPullRequest,
  History,
  Fingerprint,
  KeyRound,
  Box,
  LayoutDashboard,
  LayoutGrid,
  ListTree,
  Lock,
  LogOut,
  Menu,
  Plus,
  Search,
  Plug,
  Settings,
  Users,
  Webhook,
  PlayCircle,
  Activity,
  Bot,
  Kanban,
  ShieldCheck,
  Rocket,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, NavLink, useLocation, useNavigate, useNavigation, useSubmit } from "react-router";

import type { User } from "@g1t/contracts";
import { MICROS_PER_DOLLAR } from "@g1t/contracts";

import { Mark } from "./logo";
import { Avatar } from "./ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";

/** What the sidebar needs, worked out by the root loader for a signed-in person. */
export type ShellData = {
  /** The workspace the sidebar is about: the one being looked at, or their first. */
  workspace: { slug: string; role: "owner" | "member" } | null;
  /** Its projects, by name: `name` is the slug in their address. */
  repos: { namespace: string; name: string; title?: string; isPrivate: boolean }[];
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
};

function SidebarLink({
  to,
  icon,
  end,
  count,
  also,
  children,
}: {
  to: string;
  icon: ReactNode;
  end?: boolean;
  count?: number;
  /** Other path prefixes under which this link is the current one. */
  also?: string | string[];
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
 * A section of the project menu that opens to show its pages, as GitLab's
 * does: one row with an icon, and its pages indented under it. It opens
 * by itself when one of its pages is the current one, and otherwise
 * remembers whether it was left open.
 */
function SidebarSection({
  title,
  icon,
  paths = [],
  soon = false,
  children,
}: {
  title: string;
  icon: ReactNode;
  /** Path prefixes of its pages: one being current opens it. */
  paths?: string[];
  /** Nothing in it is built yet. */
  soon?: boolean;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  const current = paths.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
  const key = `g1t.sidebar.${title}`;
  const [open, setOpen] = useState<boolean>(current);
  // What the person left it as, once the page is in the browser.
  useEffect(() => {
    if (current) {
      setOpen(true);
      return;
    }
    try {
      const saved = localStorage.getItem(key);
      if (saved != null) setOpen(saved === "1");
    } catch {
      // No storage: it stays as it is.
    }
  }, [current, key]);
  const toggle = () => {
    const next = !open;
    setOpen(next);
    try {
      localStorage.setItem(key, next ? "1" : "0");
    } catch {
      // Remembered for this page only.
    }
  };
  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className={`group flex h-8 w-full items-center gap-2.5 rounded-md px-2 text-left text-[0.8125rem] transition-colors hover:bg-raised/60 ${
          current ? "text-fg" : soon ? "text-faint hover:text-muted" : "text-muted hover:text-fg"
        }`}
      >
        <span className={`shrink-0 ${current ? "text-muted" : "text-faint group-hover:text-muted"}`}>{icon}</span>
        <span className={`min-w-0 grow truncate ${current ? "font-medium" : ""}`}>{title}</span>
        {soon && !open && (
          <span className="rounded-full px-1.5 py-px text-[0.625rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">
            Soon
          </span>
        )}
        <ChevronRight
          size={14}
          className={`shrink-0 text-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
          aria-hidden="true"
        />
      </button>
      {open && (
        <div className="relative mt-px mb-1 space-y-px before:absolute before:top-1 before:bottom-1 before:left-[1.1875rem] before:w-px before:bg-line">
          {children}
        </div>
      )}
    </section>
  );
}

/** A page inside a section: indented, without an icon of its own. */
function SidebarSubLink({
  to,
  end,
  count,
  also,
  children,
}: {
  to: string;
  end?: boolean;
  count?: number;
  also?: string | string[];
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
        return `relative flex h-8 items-center gap-2 rounded-md pr-2 pl-[2.375rem] text-[0.8125rem] transition-colors ${
          current
            ? "bg-raised font-medium text-fg before:absolute before:top-1.5 before:bottom-1.5 before:left-[1.1875rem] before:z-10 before:w-px before:bg-accent"
            : isPending
              ? "bg-raised/60 text-fg"
              : "text-muted hover:bg-raised/60 hover:text-fg"
        }`;
      }}
    >
      <span className="min-w-0 grow truncate">{children}</span>
      {count != null && count > 0 && (
        <span className="rounded bg-line px-1.5 text-[0.6875rem] tabular-nums text-muted">{count}</span>
      )}
    </NavLink>
  );
}

/** A page a section will have: shown so people can see where g1t is going. */
function SidebarSubSoon({ about, children }: { about: string; children: ReactNode }) {
  return (
    <div
      title={about}
      aria-disabled="true"
      className="flex h-8 cursor-default items-center gap-2 rounded-md pr-2 pl-[2.375rem] text-[0.8125rem] text-faint"
    >
      <span className="grow truncate">{children}</span>
      <span className="rounded-full px-1.5 py-px text-[0.625rem] font-medium tracking-wide text-muted uppercase ring-1 ring-line">
        Soon
      </span>
    </div>
  );
}

function SidebarGroup({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="mt-6">
      <div className="mb-1 flex h-6 items-center justify-between px-2">
        <h2 className="text-xs font-medium text-faint">{title}</h2>
        {action}
      </div>
      <div className="space-y-px">{children}</div>
    </section>
  );
}

function WorkspaceSwitcher({ user, shell }: { user: User; shell: ShellData }) {
  const current = shell.workspace?.slug;
  return (
    <DropdownMenu>
      {/* The name goes to the workspace; only the arrows switch it. */}
      <Link
        to={current ? `/${current}` : "/workspaces/new"}
        className="flex h-8 min-w-0 items-center gap-2 rounded-md px-1.5 transition-colors hover:bg-raised"
      >
        {current ? (
          <Avatar name={current} size={20} square />
        ) : (
          <span className="size-5 rounded-md border border-dashed border-line-strong" />
        )}
        <span className="min-w-0 truncate text-sm font-medium">{current ?? "Choose a workspace"}</span>
        {shell.workspace && (
          <span className="shrink-0 rounded-full bg-raised px-1.5 py-px text-[0.625rem] font-medium text-muted ring-1 ring-line capitalize">
            {shell.workspace.role}
          </span>
        )}
      </Link>
      <DropdownMenuTrigger
        aria-label="Switch workspace"
        className="ml-auto flex h-8 w-6 shrink-0 items-center justify-center rounded-md text-faint outline-none transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg"
      >
        <ChevronsUpDown size={14} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-60">
        <DropdownMenuLabel>Workspaces</DropdownMenuLabel>
        {(user.workspaces ?? []).map((membership) => (
          <DropdownMenuItem asChild key={membership.slug}>
            <Link to={`/${membership.slug}`}>
              <Avatar name={membership.slug} size={16} square />
              <span className="grow">{membership.slug}</span>
              {membership.slug === current && <Check className="text-accent" />}
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

/**
 * This month's usage, and how close the workspace is to its usage limit,
 * as Vercel shows a plan's usage.
 */
function UsageCard({ slug, shell }: { slug: string; shell: ShellData }) {
  if (shell.monthUsageMicros == null) return null;
  const spent = shell.monthUsageMicros;
  const limit = shell.limit;
  const ceiling = limit?.ceilingMicros ?? null;
  const share = limit && ceiling ? Math.min(1, limit.exposureMicros / Math.max(ceiling, 1)) : 0;
  const tone = limit?.state === "stopped" ? "text-danger" : limit?.state === "warning" ? "text-warn" : "text-faint";
  const bar = limit?.state === "stopped" ? "bg-danger" : limit?.state === "warning" ? "bg-warn" : "bg-accent";
  return (
    <Link
      to={`/${slug}/-/usage`}
      className="block rounded-lg bg-surface p-3 ring-1 ring-line transition-colors hover:ring-line-strong"
    >
      <span className="flex items-baseline justify-between text-xs">
        <span className="font-medium text-fg">Usage</span>
        <span className="text-faint">this month</span>
      </span>
      <span className="mt-2 flex items-baseline justify-between">
        <span className="font-mono text-sm tabular-nums">${(spent / MICROS_PER_DOLLAR).toFixed(2)}</span>
        {shell.free ? (
          <span className="text-xs text-accent">Free for now</span>
        ) : limit?.comped ? (
          <span className="text-xs text-accent">Comped</span>
        ) : (
          ceiling != null && (
            <span className={`text-xs ${tone}`}>
              {limit?.state === "stopped" ? "Limit reached" : `$${(ceiling / MICROS_PER_DOLLAR).toFixed(2)} limit`}
            </span>
          )
        )}
      </span>
      {ceiling != null && !limit?.comped && (
        <span className="mt-2 block h-1 overflow-hidden rounded-full bg-raised">
          <span
            className={`block h-full rounded-full ${bar}`}
            style={{ width: `${Math.max(share * 100, share > 0 ? 3 : 0)}%` }}
          />
        </span>
      )}
    </Link>
  );
}

function AccountMenu({ user }: { user: User }) {
  const submit = useSubmit();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex h-10 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none transition-colors hover:bg-raised data-[state=open]:bg-raised">
        <Avatar name={user.username} size={22} />
        <span className="min-w-0 grow truncate text-[0.8125rem] font-medium">{user.username}</span>
        <Ellipsis size={15} className="shrink-0 text-faint" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-56">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A workspace's settings pages, which the sidebar slides over to. */
const SETTINGS_PAGE = /^\/([^/]+)\/-\/(settings|people|tokens|billing|integrations|webhooks|secrets)(\/|$)/;

/**
 * The sidebar's menus are two layers, the way a phone pushes a screen: the
 * one arriving slides in from the right over the full width, while the one
 * leaving drifts a quarter of the way left and fades, both on one long
 * ease-out, the fade quicker than the move so the two never blur together.
 * Going back reverses it.
 */
const LAYER =
  "absolute inset-0 [transition:translate_380ms_cubic-bezier(0.32,0.72,0,1),opacity_220ms_ease-out] will-change-[translate,opacity] motion-reduce:transition-none";
/** One menu, filling its layer. */
const PANEL = "h-full overflow-y-auto px-2 pb-4";

/** A workspace's settings, as the sidebar shows them in place of everything else. */
function SettingsMenu({ slug, owner, open }: { slug: string; owner: boolean; open: boolean }) {
  return (
    <nav
      aria-label="Workspace settings"
      inert={!open}
      className={PANEL}
    >
      <Link
        to={`/${slug}`}
        className="group mt-3 flex h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-muted transition-colors hover:bg-raised/60 hover:text-fg"
      >
        <ArrowLeft size={15} className="text-faint transition-transform group-hover:-translate-x-0.5 group-hover:text-muted" />
        <span className="truncate">{slug}</span>
      </Link>
      <SidebarGroup title="Settings">
        {owner && (
          <SidebarLink to={`/${slug}/-/settings`} icon={<Settings size={15} />}>
            General
          </SidebarLink>
        )}
        <SidebarLink to={`/${slug}/-/people`} icon={<Users size={15} />}>
          Members
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/tokens`} icon={<KeyRound size={15} />}>
          Access tokens
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/billing`} icon={<CreditCard size={15} />}>
          Billing and plans
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/integrations`} icon={<Plug size={15} />}>
          Integrations
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/secrets`} icon={<Lock size={15} />}>
          Secrets and variables
        </SidebarLink>
        <SidebarLink to={`/${slug}/-/webhooks`} icon={<Webhook size={15} />}>
          Webhooks
        </SidebarLink>
      </SidebarGroup>
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
 * A project's own menu, which the sidebar slides to while you are in it,
 * as it does for settings: everything about the project, running and its
 * code, and nothing else, with the way back to everything.
 */
function RepoMenu({ repo, isPrivate, open }: { repo: MenuRepo; isPrivate: boolean; open: boolean }) {
  const base = `/${repo.namespace}/${repo.name}`;
  return (
    <nav aria-label={`${repo.namespace}/${repo.name}`} inert={!open} className={PANEL}>
      <Link
        to="/"
        className="group mt-3 flex h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-muted transition-colors hover:bg-raised/60 hover:text-fg"
      >
        <ArrowLeft size={15} className="text-faint transition-transform group-hover:-translate-x-0.5 group-hover:text-muted" />
        Mission control
      </Link>
      <Link
        to={base}
        className="mt-3 flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-raised/60"
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-raised text-muted ring-1 ring-line">
          {isPrivate ? <Lock size={13} /> : <Box size={13} />}
        </span>
        <span className="min-w-0 truncate font-mono text-[0.8125rem]">
          <span className="text-faint">{repo.namespace}/</span>
          <span className="font-semibold text-fg">{repo.name}</span>
        </span>
      </Link>
      <div className="mt-3 space-y-px">
        <SidebarLink to={base} end icon={<LayoutGrid size={15} />}>
          Overview
        </SidebarLink>

        <SidebarSection title="Plan" icon={<Kanban size={15} />} paths={[`${base}/issues`, `${base}/plans`]}>
          <SidebarSubLink to={`${base}/issues`} count={repo.issues}>
            Issues
          </SidebarSubLink>
          {repo.member && <SidebarSubLink to={`${base}/plans`}>Outcomes</SidebarSubLink>}
          <SidebarSubSoon about="Issues and pull requests on boards, by state, owner or outcome.">Boards</SidebarSubSoon>
          <SidebarSubSoon about="Dates to land outcomes by, with what is left and what is at risk.">Milestones</SidebarSubSoon>
          <SidebarSubSoon about="Pages about the project that agents keep current as the code changes.">Wiki</SidebarSubSoon>
        </SidebarSection>

        <SidebarSection
          title="Code"
          icon={<Code2 size={15} />}
          paths={[`${base}/pulls`, `${base}/pull`, `${base}/queue`, `${base}/code`, `${base}/tree`, `${base}/blob`, `${base}/commits`, `${base}/commit`]}
        >
          <SidebarSubLink to={`${base}/pulls`} also={`${base}/pull`} count={repo.pulls}>
            Pull requests
          </SidebarSubLink>
          <SidebarSubLink to={`${base}/queue`}>Merge queue</SidebarSubLink>
          <SidebarSubLink to={`${base}/code`} also={[`${base}/tree`, `${base}/blob`]}>
            Files
          </SidebarSubLink>
          <SidebarSubLink to={`${base}/commits`} also={`${base}/commit`}>
            Commits
          </SidebarSubLink>
          <SidebarSubSoon about="Every branch, who and what is on it, how far behind it is, and its preview.">Branches</SidebarSubSoon>
          <SidebarSubSoon about="Tags, and the releases made from them.">Tags</SidebarSubSoon>
        </SidebarSection>

        <SidebarSection title="Agents" icon={<Bot size={15} />} soon>
          <SidebarSubSoon about="Every agent at work on this project now: what it is doing, what it knows, and a way to steer it.">
            At work
          </SidebarSubSoon>
          <SidebarSubSoon about="Every agent session that changed this project, searchable, with why-blame back to the lines it wrote.">
            Sessions
          </SidebarSubSoon>
          <SidebarSubSoon about="How agents should work here: conventions, commands and checks, kept with the code.">
            Playbooks
          </SidebarSubSoon>
        </SidebarSection>

        <SidebarSection title="Build" icon={<PlayCircle size={15} />} paths={[`${base}/actions`]}>
          <SidebarSubLink to={`${base}/actions`}>Actions</SidebarSubLink>
          <SidebarSubSoon about="g1t's machines, or your own, that run workflow jobs and checks.">Runners</SidebarSubSoon>
          <SidebarSubSoon about="What builds and workflow jobs produce, kept and downloadable.">Artifacts</SidebarSubSoon>
          <SidebarSubSoon about="Workflows that run on a timetable, and their history.">Schedules</SidebarSubSoon>
        </SidebarSection>

        <SidebarSection title="Deploy" icon={<Rocket size={15} />} paths={repo.member ? [`${base}/deployments`] : []}>
          {repo.member && <SidebarSubLink to={`${base}/deployments`}>Deployments</SidebarSubLink>}
          <SidebarSubSoon about="Staging and other environments, with required approvers and branch rules.">Environments</SidebarSubSoon>
          <SidebarSubSoon about="Tagged releases with notes written from what landed.">Releases</SidebarSubSoon>
          <SidebarSubSoon about="npm, container and other packages published from the project.">Packages</SidebarSubSoon>
          <SidebarSubSoon about="Turn features on per environment or per user, without a deploy.">Feature flags</SidebarSubSoon>
        </SidebarSection>

        <SidebarSection title="Secure" icon={<ShieldCheck size={15} />} soon>
          <SidebarSubSoon about="Every finding in one place, by severity, with the agent fixing each.">Security overview</SidebarSubSoon>
          <SidebarSubSoon about="Keys and tokens found in the code or its history, revoked and removed by an agent.">
            Secret scanning
          </SidebarSubSoon>
          <SidebarSubSoon about="Outdated and vulnerable packages, updated by agents, tested and landed through the queue.">
            Dependency updates
          </SidebarSubSoon>
          <SidebarSubSoon about="Code scanned for vulnerabilities on every change, each finding fixed through the queue.">
            Code scanning
          </SidebarSubSoon>
        </SidebarSection>

        <SidebarSection title="Operate" icon={<Activity size={15} />} soon>
          <SidebarSubSoon about="Requests, errors and CPU time of each deployment, and its logs.">Logs and metrics</SidebarSubSoon>
          <SidebarSubSoon about="Errors and incidents from the running app, each becoming an issue an agent can take.">
            Errors and incidents
          </SidebarSubSoon>
          <SidebarSubSoon about="Checks that the app answers, from around the world, and who is told when it does not.">Uptime</SidebarSubSoon>
        </SidebarSection>

        <SidebarSection title="Analyze" icon={<BarChart3 size={15} />} soon>
          <SidebarSubSoon about="How work flows: lead time, review time, and the share of changes agents make.">Insights</SidebarSubSoon>
          <SidebarSubSoon about="What the project costs, by agent run, sandbox, build and app.">Costs</SidebarSubSoon>
          <SidebarSubSoon about="Deploy frequency, lead time, change failure rate and time to restore.">Delivery metrics</SidebarSubSoon>
        </SidebarSection>

        {repo.member && (
          <SidebarSection title="Settings" icon={<Settings size={15} />} paths={[`${base}/settings`]}>
            <SidebarSubLink to={`${base}/settings`} end>
              General
            </SidebarSubLink>
            <SidebarSubLink to={`${base}/settings/repository`}>Repository</SidebarSubLink>
            <SidebarSubLink to={`${base}/settings/deployments`}>Deployments</SidebarSubLink>
            <SidebarSubLink to={`${base}/settings/dependencies`}>Dependencies</SidebarSubLink>
            <SidebarSubLink to={`${base}/settings/secrets`}>Secrets and variables</SidebarSubLink>
            <SidebarSubLink to={`${base}/settings/webhooks`}>Webhooks</SidebarSubLink>
          </SidebarSection>
        )}
      </div>
    </nav>
  );
}

/** Your own settings, as the sidebar shows them on the settings page. */
function AccountSettingsMenu({ open }: { open: boolean }) {
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
    <nav
      aria-label="Your settings"
      inert={!open}
      className={PANEL}
    >
      <Link
        to="/"
        className="group mt-3 flex h-8 items-center gap-2 rounded-md px-2 text-[0.8125rem] text-muted transition-colors hover:bg-raised/60 hover:text-fg"
      >
        <ArrowLeft size={15} className="text-faint transition-transform group-hover:-translate-x-0.5 group-hover:text-muted" />
        Mission control
      </Link>
      <SidebarGroup title="Account">
        {item("ssh-keys", <Fingerprint size={15} />, "SSH keys")}
        {item("tokens", <KeyRound size={15} />, "Access tokens")}
        {item("applications", <Plug size={15} />, "Connected applications")}
      </SidebarGroup>
    </nav>
  );
}

function Sidebar({ user, shell, onFind }: { user: User; shell: ShellData; onFind: () => void }) {
  const ws = shell.workspace;
  const { pathname } = useLocation();
  const going = useNavigation().location?.pathname;
  // On a workspace's settings page, or on the way to one, its settings take
  // the sidebar over.
  const inSettings = ws != null && SETTINGS_PAGE.exec(going ?? pathname)?.[1]?.toLowerCase() === ws.slug;
  const inAccount = (going ?? pathname) === "/settings";
  const active = shell.repo;
  // In a repository, or on the way into one, its own menu takes the sidebar.
  const target = going ?? pathname;
  const repoPath = /^\/([^/]+)\/([^/-][^/]*)(\/|$)/.exec(target);
  const reserved = new Set(["settings", "explore", "search", "new", "workspaces", "login", "logout", "register", "verify", "forgot", "reset", "device", "oauth"]);
  const inRepo = repoPath != null && !reserved.has(repoPath[1]) && repoPath[2] !== "-";
  const away = inSettings || inAccount || inRepo;
  // The repository the menu is for: the one loaded if it is the one being
  // gone to, else what the address says, at once.
  const targetRepo = inRepo && repoPath ? { namespace: repoPath[1], name: repoPath[2] } : null;
  const menuRepo: MenuRepo | null = targetRepo
    ? sameRepo(active, targetRepo)
      ? active
      : {
          ...targetRepo,
          member: (user.workspaces ?? []).some((m) => m.slug === targetRepo.namespace.toLowerCase()),
        }
    : null;
  // What sits on the far side of the track. Kept while sliding back, so it
  // does not vanish on the way out.
  const side = useRef<"workspace" | "account" | "repo">("workspace");
  if (inAccount) side.current = "account";
  else if (inSettings) side.current = "workspace";
  else if (inRepo) side.current = "repo";
  // The repository last shown, kept for the slide back.
  const shown = useRef<MenuRepo | null>(menuRepo);
  if (menuRepo) shown.current = menuRepo;
  // Moving between two of the far-side menus (settings to a repository,
  // one repository to another) crossfades in place instead of sliding.
  const detailKey = side.current === "repo" ? `repo:${shown.current?.namespace}/${shown.current?.name}` : side.current;
  const lastAway = useRef(away);
  const lastKey = useRef(detailKey);
  const swapped = lastAway.current && away && lastKey.current !== detailKey;
  useEffect(() => {
    lastAway.current = away;
    lastKey.current = detailKey;
  });
  // The repository being looked at is listed even when it is someone else's.
  const listed =
    active && !shell.repos.some((repo) => repo.namespace === active.namespace && repo.name === active.name)
      ? [{ namespace: active.namespace, name: active.name, isPrivate: false }, ...shell.repos]
      : shell.repos;
  return (
    <div className="flex h-full flex-col">
      {/* The same height and rule as the top bar, so the two read as one line. */}
      <div className="flex h-16 shrink-0 items-center gap-2 border-b border-line px-3">
        <Link to="/" aria-label="g1t home" className="shrink-0 rounded-md p-2 hover:bg-raised">
          <Mark className="size-6" />
        </Link>
        <span className="shrink-0 text-line-strong" aria-hidden="true">
          /
        </span>
        <WorkspaceSwitcher user={user} shell={shell} />
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
      <div className="relative min-h-0 grow overflow-hidden">
      <div className={`${LAYER} ${away ? "pointer-events-none -translate-x-1/4 opacity-0" : "translate-x-0 opacity-100"}`}>
      <nav aria-label="g1t" inert={away} className={PANEL}>
        <div className="mt-3 space-y-px">
          <SidebarLink to="/" end icon={<LayoutDashboard size={15} />}>
            Mission control
          </SidebarLink>
          <SidebarLink to="/explore" icon={<Compass size={15} />}>
            Explore
          </SidebarLink>
        </div>

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
          {listed.length === 0 && (
            <p className="px-2 py-1 text-xs text-faint">None yet.</p>
          )}
          {listed.map((repo) => {
            const base = `/${repo.namespace}/${repo.name}`;
            return (
              <div key={base}>
                <SidebarLink
                  to={base}
                  icon={repo.isPrivate ? <Lock size={15} /> : <Box size={15} />}
                >
                  <span className="text-[0.8125rem]">
                    {repo.namespace !== ws?.slug && (
                      <span className="font-mono text-faint">{repo.namespace}/</span>
                    )}
                    {"title" in repo && repo.title ? repo.title : repo.name}
                  </span>
                </SidebarLink>
              </div>
            );
          })}
        </SidebarGroup>
      </nav>
      </div>
      <div className={`${LAYER} ${away ? "translate-x-0 opacity-100" : "pointer-events-none translate-x-full opacity-0"}`}>
        <div key={detailKey} className={`h-full ${swapped ? "animate-[g1t-swap_220ms_ease-out]" : ""}`}>
          {side.current === "repo" && shown.current ? (
            <RepoMenu
              repo={shown.current}
              isPrivate={shell.repos.some((repo) => sameRepo(repo, shown.current) && repo.isPrivate)}
              open={inRepo}
            />
          ) : side.current === "account" || !ws ? (
            <AccountSettingsMenu open={inAccount} />
          ) : (
            <SettingsMenu slug={ws.slug} owner={ws.role === "owner"} open={inSettings} />
          )}
        </div>
      </div>
      </div>

      {/* The workspace's own things sit at the bottom, by its usage and the
          account: a panel of their own, ruled off from whatever menu is above,
          however long it grows. */}
      <div className="shrink-0 space-y-2 border-t border-line bg-surface/50 p-2 pt-3">
        {ws && (
          <div className="space-y-px">
            <p className="flex items-center gap-2 px-2 pb-1 text-[0.6875rem] font-medium uppercase tracking-wider text-faint">
              <span>Workspace</span>
              <span className="min-w-0 truncate font-mono normal-case tracking-normal text-muted">{ws.slug}</span>
            </p>
            <SidebarLink to={`/${ws.slug}/-/usage`} icon={<BarChart3 size={15} />}>
              Usage
            </SidebarLink>
            {/* Everything else about the workspace lives in its settings, and only there. */}
            <SidebarLink
              to={ws.role === "owner" ? `/${ws.slug}/-/settings` : `/${ws.slug}/-/people`}
              icon={<Settings size={15} />}
            >
              Settings
            </SidebarLink>
          </div>
        )}
        {ws && <UsageCard slug={ws.slug} shell={shell} />}
        <AccountMenu user={user} />
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
  plans: "Plan",
  actions: "Actions",
  deployments: "Deployments",
  repository: "Repository",
  dependencies: "Dependencies",
  code: "Code",
  secrets: "Secrets and variables",
  settings: "Settings",
  people: "Members",
  tokens: "Access tokens",
  usage: "Usage",
  billing: "Billing and plans",
  integrations: "Integrations",
  webhooks: "Webhooks",
  tree: "Code",
  blob: "Code",
};

/** Where the page is, as a trail of links: workspace / repository / section. */
function Breadcrumbs({ pathname }: { pathname: string }) {
  const parts = pathname.split("/").filter(Boolean);
  const reserved = ["settings", "explore", "new", "search", "workspaces"];
  if (parts.length === 0) return <span className="text-sm font-medium">Mission control</span>;
  if (reserved.includes(parts[0]!)) {
    const words: Record<string, string> = {
      settings: "Account",
      explore: "Explore",
      new: "New project",
      search: "Search",
      workspaces: "New workspace",
    };
    return <span className="text-sm font-medium">{words[parts[0]!]}</span>;
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
        <span key={crumb.to} className="flex min-w-0 items-center gap-1.5">
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

type Command = { label: string; hint?: string; to: string; icon: ReactNode };

/** Everything the palette can jump to, from what the sidebar already knows. */
function commandsFor(user: User, shell: ShellData): Command[] {
  const commands: Command[] = [
    { label: "Mission control", to: "/", icon: <LayoutDashboard size={15} /> },
    { label: "Explore repositories", to: "/explore", icon: <Compass size={15} /> },
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
      { label: membership.slug, hint: "Workspace", to: `/${membership.slug}`, icon: <Avatar name={membership.slug} size={15} square /> },
      { label: "Usage", hint: membership.slug, to: `/${membership.slug}/-/usage`, icon: <BarChart3 size={15} /> },
      { label: "Billing and plans", hint: `${membership.slug} · Settings`, to: `/${membership.slug}/-/billing`, icon: <CreditCard size={15} /> },
      { label: "Access tokens", hint: `${membership.slug} · Settings`, to: `/${membership.slug}/-/tokens`, icon: <KeyRound size={15} /> },
      { label: "Integrations", hint: `${membership.slug} · Settings`, to: `/${membership.slug}/-/integrations`, icon: <Plug size={15} /> },
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

function CommandPalette({
  open,
  onClose,
  commands,
}: {
  open: boolean;
  onClose: () => void;
  commands: Command[];
}) {
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return commands
      .filter((command) => {
        const text = `${command.label} ${command.hint ?? ""}`.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .slice(0, 12);
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    input.current?.focus();
  }, [open]);
  useEffect(() => setSelected(0), [query]);

  if (!open) return null;
  const go = (command: Command | undefined) => {
    if (!command) return;
    onClose();
    navigate(command.to);
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 px-4 pt-[12vh] backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Go to"
        className="w-full max-w-xl overflow-hidden rounded-xl border border-line-strong bg-raised shadow-2xl shadow-black/60"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-line px-4">
          <Search size={16} className="text-faint" />
          <input
            ref={input}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setSelected((index) => Math.min(index + 1, matches.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setSelected((index) => Math.max(index - 1, 0));
              } else if (event.key === "Enter") {
                event.preventDefault();
                go(matches[selected]);
              } else if (event.key === "Escape") {
                onClose();
              }
            }}
            placeholder="Go to a repository, a page, or an action…"
            autoComplete="off"
            data-1p-ignore
            className="h-12 grow border-0 bg-transparent text-sm shadow-none outline-none ring-0 placeholder:text-faint focus:outline-none focus-visible:outline-none"
          />
          <kbd className="rounded border border-line px-1.5 font-mono text-[0.6875rem] text-faint">esc</kbd>
        </div>
        <ul className="max-h-[50vh] overflow-y-auto p-1.5">
          {matches.length === 0 && (
            <li className="px-3 py-6 text-center text-sm text-faint">Nothing matches.</li>
          )}
          {matches.map((command, index) => (
            <li key={`${command.to}-${command.label}`}>
              <button
                type="button"
                onMouseEnter={() => setSelected(index)}
                onClick={() => go(command)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm ${
                  index === selected ? "bg-line text-fg" : "text-muted"
                }`}
              >
                <span className="shrink-0 text-faint">{command.icon}</span>
                <span className="min-w-0 grow truncate">{command.label}</span>
                {command.hint && <span className="shrink-0 truncate text-xs text-faint">{command.hint}</span>}
                {index === selected && <CornerDownLeft size={13} className="shrink-0 text-faint" />}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
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
 * The signed-in app: a sidebar with the workspace, its repositories and the
 * sections of the one being looked at; a slim bar with search and the
 * account; and the page.
 */
export function AppShell({
  user,
  shell,
  banner,
  children,
}: {
  user: User;
  shell: ShellData;
  banner?: ReactNode;
  children: ReactNode;
}) {
  const submit = useSubmit();
  const { pathname } = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const commands = useMemo(() => commandsFor(user, shell), [user, shell]);

  // A new page closes the drawer on small screens.
  useEffect(() => setDrawer(false), [pathname]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

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
            <button
              type="button"
              aria-label="Close menu"
              onClick={() => setDrawer(false)}
              className="absolute top-3 right-3 rounded-md p-1 text-faint hover:bg-raised hover:text-fg"
            >
              <X size={16} />
            </button>
            <Sidebar user={user} shell={shell} onFind={() => setPalette(true)} />
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
          <div className="ml-auto flex items-center gap-1.5">
            <a
              href="https://docs.g1t.sh/"
              className="hidden rounded-md px-2.5 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-fg sm:block"
            >
              Docs
            </a>
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
          </div>
        </header>
        {banner}
        <main className="min-w-0 grow">{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
    </div>
  );
}
