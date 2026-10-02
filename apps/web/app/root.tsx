import {
  Form,
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { Logo } from "./components/logo";
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
    href: "https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=JetBrains+Mono:wght@400;600&display=swap",
  },
];

export const middleware: Route.MiddlewareFunction[] = [viewerMiddleware];

export function loader({ context }: Route.LoaderArgs) {
  return { user: getViewer(context) };
}

export function Layout({ children }: { children: React.ReactNode }) {
  // Undefined when the root loader itself failed.
  const user = useRouteLoaderData<typeof loader>("root")?.user;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <Links />
      </head>
      <body>
        <header className="border-b border-line">
          <nav className="mx-auto flex max-w-5xl items-center px-4 py-3">
            <Link to="/" aria-label="g1t home">
              <Logo />
            </Link>
            <div className="ml-auto flex items-center gap-4 text-sm text-muted">
              {user ? (
                <>
                  <Link to="/new" className="hover:text-fg">
                    New repository
                  </Link>
                  <Link to="/settings" className="font-mono hover:text-fg">
                    {user.username}
                  </Link>
                  <Form method="post" action="/logout">
                    <button type="submit" className="hover:text-fg">
                      Sign out
                    </button>
                  </Form>
                </>
              ) : (
                <Link to="/login" className="hover:text-fg">
                  Sign in
                </Link>
              )}
            </div>
          </nav>
        </header>
        {children}
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
  let message = "Oops!";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    message = error.status === 404 ? "404" : "Error";
    details =
      error.status === 404
        ? "The requested page could not be found."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto max-w-5xl px-4 pt-16">
      <h1 className="font-mono text-2xl font-semibold">{message}</h1>
      <p className="mt-2 text-muted">{details}</p>
      {stack && (
        <pre className="mt-4 w-full overflow-x-auto p-4">
          <code>{stack}</code>
        </pre>
      )}
    </main>
  );
}
