import {
  BookOpen,
  ChevronDown,
  LayoutDashboard,
  LogOut,
  Plus,
  Search,
  Settings,
} from "lucide-react";
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
  useRouteLoaderData,
  useSubmit,
} from "react-router";

import type { User } from "@g1t/contracts";

import type { Route } from "./+types/root";
import "./app.css";
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
import { billing, repos, work } from "./lib/services.server";
import { getViewer, roleIn, viewerMiddleware } from "./lib/session.server";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap",
  },
];

export const middleware: Route.MiddlewareFunction[] = [viewerMiddleware];

export async function loader({ context, params }: Route.LoaderArgs) {
  const user = getViewer(context);
  return { user, shell: user ? await shellFor(user, params) : null };
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
 * The sidebar: the workspace being looked at if they belong to it, else
 * their first; its repositories; and the repository being looked at.
 */
async function shellFor(
  user: User,
  params: { owner?: string; repo?: string },
): Promise<ShellData> {
  const memberships = user.workspaces ?? [];
  const here = params.owner ? memberships.find((m) => m.slug === params.owner?.toLowerCase()) : undefined;
  const workspace = here ?? memberships[0] ?? null;
  const path = params.owner && params.repo ? { namespace: params.owner, name: params.repo } : null;
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const [listed, counts, account, usage] = await Promise.all([
    workspace ? repos.list(user, { namespace: workspace.slug }) : Promise.resolve([]),
    path ? work.counts(path, user) : Promise.resolve(null),
    workspace ? billing.account(workspace.slug, user) : Promise.resolve(null),
    workspace ? billing.usage(workspace.slug, user, monthStart) : Promise.resolve(null),
  ]);
  return {
    workspace,
    repos: listed
      .filter((repo) => !repo.forkOf)
      .map(({ namespace, name, isPrivate }) => ({ namespace, name, isPrivate })),
    repo:
      path && counts?.ok
        ? {
            ...path,
            member: roleIn(user, path.namespace) != null,
            issues: counts.value.issues,
            pulls: counts.value.pulls,
          }
        : null,
    creditMicros:
      account?.ok && account.value.status.enabled ? account.value.balanceMicros : null,
    monthSpentMicros: usage?.ok ? usage.value.spentMicros : null,
  };
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

function Header({ user }: { user: User | null | undefined }) {
  const submit = useSubmit();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-surface/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
        <Link to="/" aria-label="g1t home" className="mr-2">
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
            placeholder="Search repositories"
            aria-label="Search repositories"
            className="w-full rounded-md border border-line bg-bg py-1.5 pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
        </Form>
        <nav className="flex items-center gap-0.5">
          <HeaderLink to="/explore">Explore</HeaderLink>
          <HeaderLink to="https://docs.g1t.sh/">Docs</HeaderLink>
        </nav>
        <div className="ml-auto flex items-center gap-2">
          {user ? (
            <>
              <Link
                to="/new"
                aria-label="New repository"
                className="rounded-md border border-line p-1.5 text-muted transition-colors hover:border-line-strong hover:text-fg"
              >
                <Plus size={16} />
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger
                  aria-label="Account menu"
                  className="flex items-center gap-1.5 rounded-md p-1 outline-none transition-colors hover:bg-raised data-[state=open]:bg-raised"
                >
                  <Avatar name={user.username} size={24} />
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
                        <Avatar name={membership.slug} size={16} square />
                        {membership.slug}
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
                      New repository
                    </Link>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem asChild>
                    <Link to="/settings">
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
              <HeaderLink to="/login">Sign in</HeaderLink>
              <ButtonLink to="/register">Sign up</ButtonLink>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

const FOOTER_LINKS: { title: string; links: [string, string][] }[] = [
  {
    title: "Product",
    links: [
      ["Explore repositories", "/explore"],
      ["g1t agents", "https://docs.g1t.sh/guides/g1t-agents/"],
      ["Bring your own agent", "https://docs.g1t.sh/guides/bring-your-own-agent/"],
      ["Sign up", "/register"],
    ],
  },
  {
    title: "Developers",
    links: [
      ["Quickstart", "https://docs.g1t.sh/quickstart/"],
      ["Concepts", "https://docs.g1t.sh/concepts/overview/"],
      ["API reference", "https://docs.g1t.sh/api/reference/"],
      ["OpenAPI", "https://api.g1t.sh/openapi.json"],
      ["llms.txt", "/llms.txt"],
    ],
  },
  {
    title: "Project",
    links: [
      ["Source on g1t", "/syntaqx/g1t"],
      ["Source on GitHub", "https://github.com/syntaqx/g1t"],
      ["MIT license", "/syntaqx/g1t/blob/main/LICENSE"],
    ],
  },
];

function Footer() {
  return (
    <footer className="mt-24 border-t border-line">
      <div className="mx-auto flex max-w-6xl flex-wrap gap-x-20 gap-y-8 px-4 py-12">
        <div className="grow">
          <Logo />
          <p className="mt-3 max-w-xs text-sm text-muted">
            A git forge for agents. Open source under the MIT license, built on
            Cloudflare Workers and Artifacts.
          </p>
        </div>
        {FOOTER_LINKS.map((group) => (
          <div key={group.title}>
            <p className="text-sm font-medium">{group.title}</p>
            <ul className="mt-3 space-y-2 text-sm text-muted">
              {group.links.map(([label, to]) => (
                <li key={to}>
                  {/* Plain links: some targets are files or other hosts. */}
                  <a href={to} className="hover:text-fg">
                    {label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-line">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-faint">
          g1t is open source software, built on Cloudflare Workers and
          Artifacts.
        </p>
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Undefined when the root loader itself failed.
  const root = useRouteLoaderData<typeof loader>("root");
  const user = root?.user;
  const banner = user && !user.verified && (
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
        {user && root?.shell ? (
          <AppShell user={user} shell={root.shell} banner={banner}>
            {children}
          </AppShell>
        ) : (
          <>
            <Progress />
            <Header user={user} />
            {banner}
            <div className="grow">{children}</div>
            <Footer />
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
    if (error.status === 404) {
      title = "Page not found";
      details = "There is nothing at this address, or you do not have access to it.";
    } else if (typeof error.data === "string" && error.data) {
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
