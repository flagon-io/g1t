import {
  BookOpen,
  ChevronDown,
  Compass,
  CreditCard,
  LayoutDashboard,
  LogIn,
  LogOut,
  Menu,
  Plus,
  Search,
  Settings,
} from "lucide-react";
import { useState } from "react";
import {
  Form,
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  NavLink,
  Outlet,
  Scripts,
  ScrollRestoration,
  type ShouldRevalidateFunctionArgs,
  useLocation,
  useParams,
  useRouteError,
  useRouteLoaderData,
  useSubmit,
} from "react-router";

import { type User, hasAccessIn, sharedWorkspaces } from "@g1t/contracts";

import type { Route } from "./+types/root";
import "./app.css";
import displayFont from "@g1t/theme/fonts/bricolage-grotesque-latin.woff2?url";
import sansFont from "@g1t/theme/fonts/hanken-grotesk-latin.woff2?url";
import { Logo } from "./components/logo";
import { Avatar, ButtonLink, notACredential } from "./components/ui";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/ui/dropdown-menu";
import { AppShell, Progress, type ShellData } from "./components/shell";
import { SiteFooter } from "./components/footer";
import { SpikeBanner } from "./components/spike-banner";
import { readCookie } from "./lib/mission";
import { WORKSPACE_COOKIE, workspaceFor } from "./lib/workspace-choice";
import { NotFound } from "./components/not-found";
import { usesAppShell } from "./lib/chrome";
import { CommandPalette, type PaletteCommand, usePaletteShortcut } from "./components/command-palette";
import { billing, projects } from "./lib/services.server";
import { countsFor, readableRepos } from "./lib/access.server";
import { shortCache } from "./lib/cache.server";
import { getViewer, viewerMiddleware } from "./lib/session.server";
import { registrationMode } from "./lib/registration.server";
import { useSignUpCopy } from "./lib/registration";


export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "icon", type: "image/png", sizes: "192x192", href: "/icon-192.png" },
  { rel: "apple-touch-icon", href: "/apple-touch-icon.png" },
  // The text and headline faces are wanted on every page, so they start
  // loading with the stylesheet; mono waits until something uses it.
  { rel: "preload", href: sansFont, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
  { rel: "preload", href: displayFont, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
];

export const middleware: Route.MiddlewareFunction[] = [viewerMiddleware];

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = getViewer(context);
  const chosen = readCookie(request.headers.get("cookie"), WORKSPACE_COOKIE);
  // What sign-up buttons say: Request access while g1t is invite-only.
  const [shell, mode] = await Promise.all([
    user ? shellFor(user, params, chosen, context) : visitorShell(params, context),
    user ? Promise.resolve(null) : registrationMode(),
  ]);
  return { user, shell, inviteOnly: mode !== "open" };
}

/**
 * The sidebar for someone not signed in: nothing of their own, only the
 * open counts of the project being looked at. One call, and only in a
 * project; it answers the same for a private project as a missing one.
 */
async function visitorShell(params: { owner?: string; repo?: string }, context: Route.LoaderArgs["context"]): Promise<ShellData> {
  const path = params.owner && params.repo ? { namespace: params.owner, name: params.repo } : null;
  const counts = path ? await countsFor(context, params) : null;
  return {
    workspace: null,
    repos: [],
    repo: path && counts?.ok ? { ...path, member: false, issues: counts.value.issues, pulls: counts.value.pulls } : null,
    limit: null,
    monthUsageMicros: null,
  };
}

/**
 * The sidebar only changes with the workspace or repository being looked
 * at, or after something was submitted: not on every page within them.
 */
export function shouldRevalidate({
  currentParams,
  nextParams,
  formMethod,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod !== "GET") return defaultShouldRevalidate;
  return currentParams.owner !== nextParams.owner || currentParams.repo !== nextParams.repo;
}

/**
 * The sidebar: the workspace you chose (lib/workspace-choice.ts), or the
 * one whose own pages these are; its projects; and the repository being
 * looked at. A project in another workspace does not switch it.
 */
async function shellFor(
  user: User,
  params: { owner?: string; repo?: string },
  chosen: string | null,
  context: Route.LoaderArgs["context"],
): Promise<ShellData> {
  const memberships = user.workspaces ?? [];
  const workspace = workspaceFor(memberships, chosen, params);
  const path = params.owner && params.repo ? { namespace: params.owner, name: params.repo } : null;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  // What the sidebar shows of the workspace changes rarely: kept for a few
  // seconds per person and workspace, except just after they changed
  // something (lib/cache.server.ts).
  const kept = <T,>(what: string, load: () => Promise<T>) =>
    workspace ? shortCache(`shell:${what}:${user.id}:${workspace.slug}`, SHELL_TTL_MS, load) : Promise.resolve(null);
  const [listed, counts, account, usage, limit, entitlements, shared] = await Promise.all([
    kept("projects", () => projects.list(workspace!.slug, user)),
    path ? countsFor(context, params) : Promise.resolve(null),
    kept("account", () => billing.account(workspace!.slug, user)),
    kept(`usage:${monthStart}`, () => billing.usage(workspace!.slug, user, monthStart)),
    kept("limit", () => billing.limit(workspace!.slug, user)).catch(() => null),
    kept("entitlements", () => billing.entitlements(workspace!.slug)).catch(() => null),
    sharedRepos(user),
  ]);
  return {
    workspace,
    // Projects are what the sidebar lists: what the workspace builds and runs.
    repos: listed?.ok
      ? listed.value.map((project) => ({
          namespace: project.workspace,
          name: project.slug,
          title: project.name,
          isPrivate: project.private,
        }))
      : [],
    repo:
      path && counts?.ok
        ? {
            ...path,
            // Until the repository's own page says what their role is.
            member: hasAccessIn(user, path.namespace),
            issues: counts.value.issues,
            pulls: counts.value.pulls,
          }
        : null,
    // Where the workspace stands against its usage limit, once billing is on.
    limit:
      account?.ok && account.value.status.enabled && limit?.ok
        ? {
            exposureMicros: limit.value.exposureMicros,
            ceilingMicros: limit.value.ceilingMicros,
            state: limit.value.state,
            comped: limit.value.trust === "internal",
          }
        : null,
    free: account?.ok ? Boolean(account.value.status.free) : false,
    // A spend spike or a hold pauses new compute: the shell says so on every page.
    compute:
      workspace && entitlements && (entitlements.paused || entitlements.spike?.status === "open")
        ? { paused: entitlements.paused, spike: entitlements.spike ?? null, owner: workspace.role === "owner" }
        : null,
    shared,
    // While g1t is free every charge is zero, so usage is shown at cost.
    monthUsageMicros: usage?.ok ? (usage.value.free ? usage.value.usedMicros : usage.value.spentMicros) : null,
  };
}

/** How long one isolate keeps the sidebar's workspace answers. */
const SHELL_TTL_MS = 15_000;

/** Most repositories listed under Shared with you. */
const MAX_SHARED = 20;

/**
 * Repositories shared with the user in workspaces they do not belong to,
 * by their grants: only those, never the workspace's other repositories.
 */
async function sharedRepos(user: User): Promise<ShellData["shared"]> {
  const outside = new Set(sharedWorkspaces(user));
  if (outside.size === 0) return [];
  const ids = (user.grants ?? []).filter((grant) => outside.has(grant.workspace)).map((grant) => grant.repo_id).slice(0, MAX_SHARED);
  const found = await readableRepos(ids, user);
  return found
    .map((repo) => ({ namespace: repo.namespace, name: repo.name, isPrivate: repo.isPrivate }))
    .sort((a, b) => `${a.namespace}/${a.name}`.localeCompare(`${b.namespace}/${b.name}`));
}

function HeaderLink({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-raised hover:text-fg ${
          isActive ? "text-fg" : "text-muted"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

/** What the palette offers someone without the app's sidebar. */
const PUBLIC_COMMANDS: PaletteCommand[] = [
  { label: "Explore", hint: "Public projects", to: "/explore", icon: <Compass size={15} /> },
  { label: "Search g1t", hint: "Repositories, code, issues, people", to: "/search", icon: <Search size={15} /> },
  { label: "Pricing", to: "/pricing", icon: <CreditCard size={15} /> },
  { label: "Documentation", to: "https://docs.g1t.sh/", icon: <BookOpen size={15} /> },
  { label: "Sign in", to: "/login", icon: <LogIn size={15} /> },
  { label: "Sign up", to: "/register", icon: <Plus size={15} /> },
];

/** Sign up, or Request access while g1t is invite-only. */
function SignUpButton() {
  const copy = useSignUpCopy();
  return <ButtonLink to="/register">{copy.primary}</ButtonLink>;
}

function Header({ user }: { user: User | null | undefined }) {
  const submit = useSubmit();
  const signUp = useSignUpCopy();
  const [palette, setPalette] = useState(false);
  usePaletteShortcut(() => setPalette((open) => !open));
  const params = useParams();
  const repo = params.owner && params.repo ? `${params.owner}/${params.repo}` : null;
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
        <Link to="/" aria-label="g1t home" className="mr-2 flex">
          <Logo />
        </Link>
        <Form action="/search" role="search" className="relative hidden grow sm:block sm:max-w-xs">
          <Search
            size={14}
            className="pointer-events-none absolute top-1/2 left-3 -translate-y-1/2 text-faint"
          />
          <input
            name="q"
            {...notACredential()}
            placeholder="Search g1t"
            aria-label="Search g1t"
            className="w-full rounded-md border border-line bg-bg py-1.5 pr-12 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
          <kbd className="pointer-events-none absolute top-1/2 right-2 -translate-y-1/2 rounded bg-raised px-1.5 font-mono text-[0.625rem] text-muted ring-1 ring-line">
            ⌘K
          </kbd>
        </Form>
        <button
          type="button"
          aria-label="Search g1t"
          onClick={() => setPalette(true)}
          className="flex size-10 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg sm:hidden"
        >
          <Search size={18} />
        </button>
        <CommandPalette
          open={palette}
          onOpenChange={setPalette}
          commands={user ? [{ label: "Mission control", to: "/", icon: <LayoutDashboard size={15} /> }, ...PUBLIC_COMMANDS.slice(0, 4)] : PUBLIC_COMMANDS.map((command) => (command.to === "/register" ? { ...command, label: signUp.primary } : command))}
          repo={repo}
        />
        <nav aria-label="Main" className="hidden items-center gap-0.5 sm:flex">
          <HeaderLink to="/explore">Explore</HeaderLink>
          <HeaderLink to="/pricing">Pricing</HeaderLink>
          <HeaderLink to="https://docs.g1t.sh/">Docs</HeaderLink>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {/* On a phone the links fold into one menu, so the bar fits. */}
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label="Menu"
              className="flex size-10 items-center justify-center rounded-md text-muted outline-none transition-colors hover:bg-raised hover:text-fg data-[state=open]:bg-raised data-[state=open]:text-fg sm:hidden"
            >
              <Menu size={18} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem asChild className="min-h-11">
                <Link to="/explore">
                  <Compass />
                  Explore
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="min-h-11">
                <Link to="/pricing">
                  <CreditCard />
                  Pricing
                </Link>
              </DropdownMenuItem>
              <DropdownMenuItem asChild className="min-h-11">
                <Link to="https://docs.g1t.sh/">
                  <BookOpen />
                  Docs
                </Link>
              </DropdownMenuItem>
              {!user && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild className="min-h-11">
                    <Link to="/login">
                      <LogIn />
                      Sign in
                    </Link>
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
          {user ? (
            <>
              <Link
                to="/new"
                aria-label="New project"
                className="rounded-md border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-fg"
              >
                <Plus size={16} />
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Account menu"
                  className="flex items-center gap-1.5 rounded-md p-1 outline-none transition-colors hover:bg-raised data-[state=open]:bg-raised"
                >
                  <Avatar name={user.username} image={user.avatar} size={24} />
                  <ChevronDown size={14} className="text-faint" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-56">
                  <DropdownMenuLabel>
                    Signed in as{" "}
                    <span className="font-mono font-medium text-fg">
                      {user.username}
                    </span>
                  </DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {(user.workspaces ?? []).map((membership) => (
                    <DropdownMenuItem asChild key={membership.slug}>
                      <Link to={`/${membership.slug}`}>
                        <Avatar name={membership.slug} image={membership.avatar} size={16} square />
                        <span className="min-w-0 truncate">{membership.name || membership.slug}</span>
                      </Link>
                    </DropdownMenuItem>
                  ))}
                  <DropdownMenuItem asChild>
                    <Link to="/workspaces/new">
                      <Plus />
                      New workspace
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/">
                      <LayoutDashboard />
                      Mission control
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="/new">
                      <Plus />
                      New project
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/settings/profile">
                      <Settings />
                      Settings
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuItem asChild>
                    <Link to="https://docs.g1t.sh/quickstart/">
                      <BookOpen />
                      Documentation
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  {/* Submitted from here: the menu closes on select, and a button
                      that has left the page cannot submit a form. */}
                  <DropdownMenuItem
                    onSelect={() => submit(null, { method: "post", action: "/logout" })}
                  >
                    <LogOut />
                    Sign out
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </>
          ) : (
            <>
              <span className="hidden sm:contents">
                <HeaderLink to="/login">Sign in</HeaderLink>
              </span>
              <SignUpButton />
            </>
          )}
        </div>
      </div>
    </header>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Undefined when the root loader itself failed.
  const root = useRouteLoaderData<typeof loader>("root");
  const user = root?.user;
  const { pathname } = useLocation();
  // Drawn around the error page too: a 404 keeps the sidebar out of a
  // project or workspace the viewer cannot see.
  const error = useRouteError();
  const missing = isRouteErrorResponse(error) && error.status === 404;
  // The billing page shows the full banner itself.
  const paused = root?.shell?.compute && root.shell.workspace && !pathname.endsWith("/-/billing") && (
    <SpikeBanner
      compact
      slug={root.shell.workspace.slug}
      entitlements={{ paused: root.shell.compute.paused, spike: root.shell.compute.spike }}
      owner={root.shell.compute.owner}
    />
  );
  const verify = user && !user.verified && (
    <Form
      method="post"
      action="/verify"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm"
    >
      <span>
        Confirm your email address to create repositories and push. We
        sent you a link.
      </span>
      <button type="submit" className="font-medium underline underline-offset-4">
        Send it again
      </button>
    </Form>
  );
  const banner =
    paused || verify ? (
      <>
        {paused}
        {verify}
      </>
    ) : null;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0f0f11" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-screen flex-col">
        {root?.shell && usesAppShell(pathname, user != null) ? (
          <AppShell user={user ?? null} shell={root.shell} missing={missing} banner={banner}>
            {children}
          </AppShell>
        ) : (
          <>
            <Progress />
            <Header user={user} />
            {banner}
            <div className="grow">{children}</div>
            <SiteFooter user={user} />
          </>
        )}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let details = "An unexpected error occurred. Try again in a moment.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    // The same page for something private and something missing.
    if (error.status === 404) return <NotFound data={error.data} />;
    if (typeof error.data === "string" && error.data) {
      details = error.data;
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-xl px-4 py-32 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-muted">{details}</p>
      <div className="mt-8">
        <ButtonLink to="/" variant="quiet">
          Back to home
        </ButtonLink>
      </div>
      {stack && (
        <pre className="mt-8 overflow-x-auto rounded-lg border border-line p-4 text-left text-xs">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
