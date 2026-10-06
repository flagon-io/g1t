import { isRouteErrorResponse, Links, Meta, Outlet, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/root";
import "./app.css";
import displayFont from "@g1t/theme/fonts/bricolage-grotesque-latin.woff2?url";
import sansFont from "@g1t/theme/fonts/hanken-grotesk-latin.woff2?url";
import { MobileBar, Sidebar } from "./components/shell";
import { ButtonLink } from "./components/ui";
import type { NavCounts } from "./lib/nav";
import { admin, identity, statusAdmin } from "./lib/services.server";
import { settle } from "./lib/settle";
import { requireStaff, zoneContext } from "./lib/staff";

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  // The faces are served by sudo itself (@g1t/theme); these two are on every page.
  { rel: "preload", href: sansFont, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
  { rel: "preload", href: displayFont, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
];

export const meta: Route.MetaFunction = () => [
  { title: "sudo · g1t" },
  { name: "robots", content: "noindex, nofollow" },
];

export async function loader({ context }: Route.LoaderArgs) {
  const { email } = requireStaff(context);
  // The sidebar's counts: a service that does not answer shows none.
  const [waitlist, incidents, alerts] = await Promise.all([
    settle(identity.waitlistPending()),
    settle(statusAdmin.openCount()),
    settle(admin.costAlerts()),
  ]);
  const counts: NavCounts = { waitlist: waitlist.ok ? waitlist.value : 0, incidents: incidents.ok ? incidents.value : 0 };
  // Every page says times in this zone (components/ui.tsx `When`).
  const { zone, chosen } = context.get(zoneContext);
  // Margin alerts (billing's margin guard): a red bar on every page until they clear.
  const rank = ["overall", "margin", "leak"];
  const margin = alerts.ok
    ? alerts.value.filter((alert) => rank.includes(alert.kind)).sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind))
    : [];
  return { email, counts, zone, zoneChosen: chosen, margin };
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
        <Sidebar email={root?.email} counts={root?.counts} />
        <MobileBar email={root?.email} counts={root?.counts} />
        <div className="lg:pl-60">
          {root?.margin && root.margin.length > 0 && (
            <div role="alert" className="border-b border-danger/40 bg-danger/12 px-4 py-2 text-sm text-danger">
              <span className="font-medium">Margin alert:</span> {root.margin[0]!.detail}
              {root.margin.length > 1 && <span className="text-danger/80"> And {root.margin.length - 1} more.</span>}{" "}
              <a href="/costs" className="underline underline-offset-2">
                Costs &amp; margin
              </a>
            </div>
          )}
          {children}
        </div>
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
