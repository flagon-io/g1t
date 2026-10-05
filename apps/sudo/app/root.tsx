import { isRouteErrorResponse, Links, Meta, Outlet, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import { MobileBar, Sidebar } from "./components/shell";
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
      <body className="min-h-screen">
        <Sidebar email={root?.email} />
        <MobileBar email={root?.email} />
        <div className="lg:pl-60">{children}</div>
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
          Back to the overview
        </ButtonLink>
      </div>
    </main>
  );
}
