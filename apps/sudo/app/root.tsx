import { Building2, Boxes, ShieldCheck } from "lucide-react";
import { isRouteErrorResponse, Link, Links, Meta, Outlet, useLocation, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { Logo } from "./components/logo";
import { ButtonLink } from "./components/ui";
import { requireStaff } from "./lib/staff";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap",
  },
];

export const meta: Route.MetaFunction = () => [
  { title: "sudo · g1t" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ context }: Route.LoaderArgs) {
  return { email: requireStaff(context).email };
}

/** A top-level section; it stays lit on the pages beneath it. */
function NavItem({ to, active, children }: { to: string; active: (path: string) => boolean; children: React.ReactNode }) {
  const { pathname } = useLocation();
  const isActive = active(pathname);
  return (
    <Link
      to={to}
      aria-current={isActive ? "page" : undefined}
      className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm transition-colors hover:bg-raised hover:text-fg ${
        isActive ? "bg-raised/60 text-fg" : "text-muted"
      }`}
    >
      {children}
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const root = useRouteLoaderData<typeof loader>("root");
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
        <header className="sticky top-0 z-40 border-b border-line bg-surface/90 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-2 px-4">
            <Link to="/" aria-label="sudo home" className="mr-1 sm:mr-3">
              <Logo />
            </Link>
            <nav className="flex items-center gap-0.5">
              <NavItem to="/" active={(path) => path === "/" || path.startsWith("/workspaces")}>
                <Boxes size={14} className="hidden sm:block" />
                Workspaces
              </NavItem>
              <NavItem to="/enterprises" active={(path) => path.startsWith("/enterprises")}>
                <Building2 size={14} className="hidden sm:block" />
                Enterprises
              </NavItem>
            </nav>
            {root?.email && (
              <span
                title="Signed in through Cloudflare Access"
                className="ml-auto hidden items-center gap-1.5 truncate rounded-md border border-line px-2 py-1 font-mono text-xs text-muted md:inline-flex"
              >
                <ShieldCheck size={13} className="text-merged" />
                {root.email}
              </span>
            )}
          </div>
        </header>
        <div className="grow">{children}</div>
        <footer className="border-t border-line">
          <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-faint">
            g1t staff only. Every change is recorded with who made it.
            {root?.email && <span className="md:hidden"> Signed in as {root.email}.</span>}
          </p>
        </footer>
        {/* No <Scripts />: sudo ships no JavaScript, and its policy allows none. */}
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let details = "An unexpected error occurred.";
  if (isRouteErrorResponse(error)) {
    title = error.status === 404 ? "Not found" : `Error ${error.status}`;
    details = typeof error.data === "string" && error.data ? error.data : error.statusText || details;
  } else if (error instanceof Error) {
    // Staff only: the real reason helps more than a polite one.
    details = error.message;
  }
  return (
    <main className="mx-auto max-w-xl px-4 py-24 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 break-words text-muted">{details}</p>
      <div className="mt-8">
        <ButtonLink to="/" variant="quiet">
          Back to workspaces
        </ButtonLink>
      </div>
    </main>
  );
}
