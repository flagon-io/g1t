import { Plus, Search } from "lucide-react";
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
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { Logo } from "./components/logo";
import { Avatar, ButtonLink } from "./components/ui";
import { getViewer, viewerMiddleware } from "./lib/session.server";

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

export function loader({ context }: Route.LoaderArgs) {
  return { user: getViewer(context) };
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

function Header({ user }: { user: { username: string } | null | undefined }) {
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
            placeholder="Search repositories"
            aria-label="Search repositories"
            className="w-full rounded-md border border-line bg-bg py-1.5 pr-3 pl-8 text-sm outline-none transition-colors placeholder:text-faint hover:border-line-strong focus:border-accent-dim"
          />
        </Form>
        <nav className="flex items-center gap-0.5">
          <HeaderLink to="/explore">Explore</HeaderLink>
          <HeaderLink to="/docs">Docs</HeaderLink>
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
              <Link
                to={`/${user.username}`}
                className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-raised"
              >
                <Avatar name={user.username} size={22} />
                <span className="hidden font-mono sm:inline">{user.username}</span>
              </Link>
              <HeaderLink to="/settings">Settings</HeaderLink>
              <Form method="post" action="/logout">
                <button
                  type="submit"
                  className="rounded-md px-2.5 py-1.5 text-sm text-muted hover:bg-raised hover:text-fg"
                >
                  Sign out
                </button>
              </Form>
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
      ["Explore", "/explore"],
      ["Sign up", "/register"],
      ["Source", "/syntaqx/g1t"],
    ],
  },
  {
    title: "Docs",
    links: [
      ["Getting started", "/docs"],
      ["Concepts", "/docs/concepts"],
      ["Connect an agent", "/docs/agents"],
      ["API", "/docs/api"],
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
                  <Link to={to} className="hover:text-fg">
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </footer>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Undefined when the root loader itself failed.
  const user = useRouteLoaderData<typeof loader>("root")?.user;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0e0d0a" />
        <Meta />
        <Links />
      </head>
      <body className="flex min-h-screen flex-col">
        <Header user={user} />
        <div className="grow">{children}</div>
        <Footer />
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
