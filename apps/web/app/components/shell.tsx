import {
  BookMarked,
  BookOpen,
  Check,
  ChevronsUpDown,
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
  Settings,
  Users,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Form, Link, NavLink, useLocation, useNavigate, useNavigation, useSubmit } from "react-router";

import type { User } from "@g1t/contracts";
import { MICROS_PER_DOLLAR } from "@g1t/contracts";

import { Logo } from "./logo";
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
        return `group flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors ${
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
    <section className="mt-5">
      <div className="mb-1 flex items-center justify-between px-2">
        <h2 className="text-[0.6875rem] font-medium tracking-wider text-faint uppercase">
          {title}
        </h2>
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
      <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-raised data-[state=open]:bg-raised">
        {current ? (
          <Avatar name={current} size={26} square />
        ) : (
          <span className="size-6.5 rounded-md border border-dashed border-line-strong" />
        )}
        <span className="min-w-0 grow">
          <span className="block truncate text-sm font-semibold">{current ?? "No workspace"}</span>
          <span className="block truncate text-xs text-faint">
            {shell.workspace?.role ?? "Create one to start"}
          </span>
        </span>
        <ChevronsUpDown size={14} className="shrink-0 text-faint" />
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

function Sidebar({ user, shell }: { user: User; shell: ShellData }) {
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
      <div className="flex h-12 items-center gap-2 px-4">
        <Link to="/" aria-label="g1t home">
          <Logo />
        </Link>
      </div>
      <div className="px-2">
        <WorkspaceSwitcher user={user} shell={shell} />
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
            <SidebarLink to={`/${ws.slug}/-/billing`} icon={<CreditCard size={15} />}>
              Billing
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

      <div className="border-t border-line p-2">
        {ws && shell.creditMicros != null && (
          <Link
            to={`/${ws.slug}/-/billing`}
            className={`mb-1 flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors hover:bg-raised ${
              shell.creditMicros <= 0 ? "text-warn" : "text-muted"
            }`}
          >
            <CreditCard size={15} className="shrink-0" />
            <span className="grow">Agent credit</span>
            <span className="font-mono text-xs tabular-nums">
              ${(shell.creditMicros / MICROS_PER_DOLLAR).toFixed(2)}
            </span>
          </Link>
        )}
        <a
          href="https://docs.g1t.sh/"
          className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm text-muted transition-colors hover:bg-raised hover:text-fg"
        >
          <BookOpen size={15} className="shrink-0 text-faint" />
          Documentation
        </a>
      </div>
    </div>
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
      { label: "Billing", hint: membership.slug, to: `/${membership.slug}/-/billing`, icon: <CreditCard size={15} /> },
      { label: "Access tokens", hint: membership.slug, to: `/${membership.slug}/-/tokens`, icon: <KeyRound size={15} /> },
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
        <Sidebar user={user} shell={shell} />
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
            <Sidebar user={user} shell={shell} />
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
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="flex h-8 w-full max-w-md items-center gap-2 rounded-md border border-line bg-surface/60 px-2.5 text-sm text-faint transition-colors hover:border-line-strong hover:text-muted"
          >
            <Search size={14} />
            <span className="grow text-left">Search or jump to…</span>
            <kbd className="hidden rounded border border-line px-1.5 font-mono text-[0.6875rem] sm:inline">⌘K</kbd>
          </button>
          <Form action="/search" className="hidden" />
          <div className="ml-auto flex items-center gap-1.5">
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Create"
                className="rounded-md border border-line p-1.5 text-muted outline-none transition-colors hover:border-line-strong hover:text-fg data-[state=open]:bg-raised"
              >
                <Plus size={15} />
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
            <DropdownMenu>
              <DropdownMenuTrigger
                aria-label="Account menu"
                className="rounded-md p-1 outline-none transition-colors hover:bg-raised data-[state=open]:bg-raised"
              >
                <Avatar name={user.username} size={24} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
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
          </div>
        </header>
        {banner}
        <main className="grow">{children}</main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} commands={commands} />
    </div>
  );
}
