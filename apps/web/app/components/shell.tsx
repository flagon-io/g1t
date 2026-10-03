import {
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
  KeyRound,
  Layers,
  LayoutDashboard,
  ListTree,
  Lock,
  LogOut,
  Menu,
  Plus,
  Search,
  Plug,
  Settings,
  Users,
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
  /** Its repositories, newest first. */
  repos: { namespace: string; name: string; isPrivate: boolean }[];
  /** The repository being looked at, if any, whoever owns it. */
  repo: {
    namespace: string;
    name: string;
    member: boolean;
    issues: number;
    pulls: number;
  } | null;
  /** The workspace's agent credit, if billing is on and they may see it. */
  creditMicros: number | null;
  /** What its agents have cost since the start of the month. */
  monthSpentMicros: number | null;
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
  /** Another path prefix under which this link is the current one. */
  also?: string;
  children: ReactNode;
}) {
  const { pathname } = useLocation();
  return (
    <NavLink
      to={to}
      end={end}
      prefetch="intent"
      className={({ isActive, isPending }) => {
        const current = isActive || (also != null && pathname.startsWith(also + "/"));
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

/** This month's spend against what is left, as Vercel shows a plan's usage. */
function UsageCard({ slug, shell }: { slug: string; shell: ShellData }) {
  if (shell.monthSpentMicros == null) return null;
  const spent = shell.monthSpentMicros;
  const left = shell.creditMicros;
  const share = left != null && spent + left > 0 ? Math.min(1, spent / (spent + Math.max(left, 0))) : 0;
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
        {left != null && (
          <span className={`text-xs ${left <= 0 ? "text-warn" : "text-faint"}`}>
            ${(left / MICROS_PER_DOLLAR).toFixed(2)} left
          </span>
        )}
      </span>
      <span className="mt-2 block h-1 overflow-hidden rounded-full bg-raised">
        <span
          className={`block h-full rounded-full ${left != null && left <= 0 ? "bg-warn" : "bg-accent"}`}
          style={{ width: `${Math.max(share * 100, spent > 0 ? 3 : 0)}%` }}
        />
      </span>
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

function Sidebar({ user, shell, onFind }: { user: User; shell: ShellData; onFind: () => void }) {
  const ws = shell.workspace;
  const active = shell.repo;
  const repoBase = active ? `/${active.namespace}/${active.name}` : null;
  // The repository being looked at is listed even when it is someone else's.
  const listed =
    active && !shell.repos.some((repo) => repo.namespace === active.namespace && repo.name === active.name)
      ? [{ namespace: active.namespace, name: active.name, isPrivate: false }, ...shell.repos]
      : shell.repos;
  return (
    <div className="flex h-full flex-col">
      {/* The same height and rule as the top bar, so the two read as one line. */}
      <div className="flex h-12 shrink-0 items-center gap-1 border-b border-line px-2">
        <Link to="/" aria-label="g1t home" className="shrink-0 rounded-md p-1.5 hover:bg-raised">
          <Mark className="size-5" />
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
          className="flex h-8 w-full items-center gap-2 rounded-md bg-surface px-2.5 text-[0.8125rem] text-faint ring-1 ring-line transition-colors hover:text-muted hover:ring-line-strong"
        >
          <Search size={14} />
          <span className="grow text-left">Find…</span>
          <kbd className="rounded bg-raised px-1.5 font-mono text-[0.625rem] text-muted ring-1 ring-line">⌘K</kbd>
        </button>
      </div>
      <nav className="min-h-0 grow overflow-y-auto px-2 pb-4">
        <div className="mt-3 space-y-px">
          <SidebarLink to="/" end icon={<LayoutDashboard size={15} />}>
            Mission control
          </SidebarLink>
          <SidebarLink to="/explore" icon={<Compass size={15} />}>
            Explore
          </SidebarLink>
        </div>

        {ws && (
          <SidebarGroup title="Workspace">
            <SidebarLink to={`/${ws.slug}`} end icon={<LayoutDashboard size={15} />}>
              Overview
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/people`} icon={<Users size={15} />}>
              People
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/tokens`} icon={<KeyRound size={15} />}>
              Access tokens
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/usage`} icon={<BarChart3 size={15} />}>
              Usage
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/billing`} icon={<CreditCard size={15} />}>
              Billing
            </SidebarLink>
            <SidebarLink to={`/${ws.slug}/-/integrations`} icon={<Plug size={15} />}>
              Integrations
            </SidebarLink>
            {ws.role === "owner" && (
              <SidebarLink to={`/${ws.slug}/-/settings`} icon={<Settings size={15} />}>
                Settings
              </SidebarLink>
            )}
          </SidebarGroup>
        )}

        <SidebarGroup
          title="Repositories"
          action={
            ws && (
              <Link
                to={`/new?workspace=${ws.slug}`}
                aria-label="New repository"
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
            const open =
              active && repo.namespace === active.namespace && repo.name === active.name;
            const base = `/${repo.namespace}/${repo.name}`;
            return (
              <div key={base}>
                <SidebarLink
                  to={base}
                  end={!open}
                  icon={repo.isPrivate ? <Lock size={15} /> : <BookMarked size={15} />}
                >
                  <span className="font-mono text-[0.8125rem]">
                    {repo.namespace !== ws?.slug && (
                      <span className="text-faint">{repo.namespace}/</span>
                    )}
                    {repo.name}
                  </span>
                </SidebarLink>
                {open && repoBase && (
                  <div className="my-0.5 ml-4 space-y-px border-l border-line pl-2">
                    <SidebarLink to={repoBase} end icon={<Code2 size={14} />} also={`${repoBase}/tree`}>
                      Code
                    </SidebarLink>
                    <SidebarLink
                      to={`${repoBase}/issues`}
                      icon={<CircleDot size={14} />}
                      count={active.issues}
                    >
                      Issues
                    </SidebarLink>
                    <SidebarLink
                      to={`${repoBase}/pulls`}
                      also={`${repoBase}/pull`}
                      icon={<GitPullRequest size={14} />}
                      count={active.pulls}
                    >
                      Pull requests
                    </SidebarLink>
                    <SidebarLink to={`${repoBase}/queue`} icon={<Layers size={14} />}>
                      Merge queue
                    </SidebarLink>
                    <SidebarLink
                      to={`${repoBase}/commits`}
                      also={`${repoBase}/commit`}
                      icon={<History size={14} />}
                    >
                      Commits
                    </SidebarLink>
                    {active.member && (
                      <SidebarLink to={`${repoBase}/plans`} icon={<ListTree size={14} />}>
                        Plan
                      </SidebarLink>
                    )}
                    {active.member && (
                      <SidebarLink to={`${repoBase}/settings`} icon={<Settings size={14} />}>
                        Settings
                      </SidebarLink>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </SidebarGroup>
      </nav>

      <div className="space-y-2 p-2">
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
  settings: "Settings",
  people: "People",
  tokens: "Access tokens",
  usage: "Usage",
  billing: "Billing",
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
      settings: "Your settings",
      explore: "Explore",
      new: "New repository",
      search: "Search",
      workspaces: "New workspace",
    };
    return <span className="text-sm font-medium">{words[parts[0]!]}</span>;
  }
  const [owner, second, third, fourth] = parts;
  const trail: { label: string; to: string; mono?: boolean }[] = [{ label: owner!, to: `/${owner}`, mono: true }];
  if (second === "-") {
    if (third) trail.push({ label: SECTIONS[third] ?? third, to: `/${owner}/-/${third}` });
  } else if (second) {
    const repo = `/${owner}/${second}`;
    trail.push({ label: second, to: repo, mono: true });
    if (third === "pull" && fourth) trail.push({ label: `Pull request #${fourth}`, to: `${repo}/pull/${fourth}` });
    else if (third === "issues" && fourth && fourth !== "new") trail.push({ label: `Issue #${fourth}`, to: `${repo}/issues/${fourth}` });
    else if (third === "commit" && fourth) trail.push({ label: fourth.slice(0, 7), to: `${repo}/commit/${fourth}`, mono: true });
    else if (third && SECTIONS[third]) trail.push({ label: SECTIONS[third]!, to: `${repo}/${third}` });
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
    { label: "New repository", to: "/new", icon: <Plus size={15} /> },
    { label: "New workspace", to: "/workspaces/new", icon: <Plus size={15} /> },
    { label: "Your settings", to: "/settings", icon: <Settings size={15} /> },
  ];
  const repo = shell.repo;
  if (repo) {
    const base = `/${repo.namespace}/${repo.name}`;
    const name = `${repo.namespace}/${repo.name}`;
    commands.unshift(
      { label: "Issues", hint: name, to: `${base}/issues`, icon: <CircleDot size={15} /> },
      { label: "New issue", hint: name, to: `${base}/issues/new`, icon: <Plus size={15} /> },
      { label: "Pull requests", hint: name, to: `${base}/pulls`, icon: <GitPullRequest size={15} /> },
      { label: "Commits", hint: name, to: `${base}/commits`, icon: <History size={15} /> },
      ...(repo.member
        ? [
            { label: "Plan work", hint: name, to: `${base}/plans`, icon: <ListTree size={15} /> },
            { label: "Repository settings", hint: name, to: `${base}/settings`, icon: <Settings size={15} /> },
          ]
        : []),
    );
  }
  for (const membership of user.workspaces ?? []) {
    commands.push(
      { label: membership.slug, hint: "Workspace", to: `/${membership.slug}`, icon: <Avatar name={membership.slug} size={15} square /> },
      { label: "Usage", hint: membership.slug, to: `/${membership.slug}/-/usage`, icon: <BarChart3 size={15} /> },
      { label: "Billing", hint: membership.slug, to: `/${membership.slug}/-/billing`, icon: <CreditCard size={15} /> },
      { label: "Access tokens", hint: membership.slug, to: `/${membership.slug}/-/tokens`, icon: <KeyRound size={15} /> },
      { label: "Integrations", hint: membership.slug, to: `/${membership.slug}/-/integrations`, icon: <Plug size={15} /> },
    );
  }
  for (const listed of shell.repos) {
    commands.push({
      label: `${listed.namespace}/${listed.name}`,
      hint: "Repository",
      to: `/${listed.namespace}/${listed.name}`,
      icon: <BookMarked size={15} />,
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

      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-bg/85 px-3 backdrop-blur sm:px-4">
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
              className="hidden rounded-md px-2 py-1 text-[0.8125rem] text-muted transition-colors hover:bg-raised hover:text-fg sm:block"
            >
              Docs
            </a>
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Create"
                className="flex h-8 items-center gap-1.5 rounded-md bg-fg px-2.5 text-[0.8125rem] font-medium text-bg outline-none transition-colors hover:bg-white"
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
                    <BookMarked />
                    New repository
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
        <main className="grow">{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
    </div>
  );
}
