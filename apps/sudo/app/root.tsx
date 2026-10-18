import { privacy } from "./lib/services.server";
import { isRouteErrorResponse, Links, Meta, Outlet, Scripts, ScrollRestoration, useRouteLoaderData } from "react-router";

import type { Route } from "./+types/root";
import appCss from "./app.css?url";
import displayFont from "@g1t/theme/fonts/bricolage-grotesque-latin.woff2?url";
import sansFont from "@g1t/theme/fonts/hanken-grotesk-latin.woff2?url";
import { Progress, useLeaving, useSettledForms } from "./components/progress";
import { MobileBar, Sidebar } from "./components/shell";
import { ButtonLink } from "./components/ui";
import type { NavCounts } from "./lib/nav";
import { pauseBanner, spendBanner } from "./lib/costs";
import { admin, statusAdmin } from "./lib/services.server";
import { settle } from "./lib/settle";
import { requireStaff, zoneContext } from "./lib/staff";
import { THEME_COLOR, THEME_COOKIE, readTheme, themeAttribute, useThemeChoice } from "./lib/theme";
import { readCookie } from "./lib/time";

export const meta: Route.MetaFunction = () => [{ title: "sudo · g1t" }, { name: "robots", content: "noindex, nofollow" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { email } = requireStaff(context);
  // The sidebar's counts: a service that does not answer shows none.
  const [incidents, alerts, caps, guard, erasures] = await Promise.all([
    settle(statusAdmin.openCount()),
    settle(admin.costAlerts()),
    settle(admin.spendCaps()),
    settle(admin.platformGuard()),
    settle(privacy.requests()),
  ]);
  const counts: NavCounts = { incidents: incidents.ok ? incidents.value : 0, privacy: erasures.ok ? erasures.value.filter((r) => !r.closed_at).length : 0 };
  // Every page says times in this zone (components/ui.tsx `When`).
  const { zone, chosen } = context.get(zoneContext);
  // Margin alerts (billing's margin guard): a red bar on every page until they clear.
  const rank = ["overall", "margin", "leak"];
  const margin = alerts.ok ? alerts.value.filter((alert) => rank.includes(alert.kind)).sort((a, b) => rank.indexOf(a.kind) - rank.indexOf(b.kind)) : [];
  // g1t's own spend (billing's budget): the daily breaker open, or a comped
  // account's monthly budget used up. Red until it clears or staff act.
  const spend = caps.ok ? spendBanner(caps.value) : null;
  // A platform pause (billing's platform.rs): red on every page while any
  // level is paused, by staff or by the usage watcher.
  const paused = guard.ok ? pauseBanner(guard.value) : null;
  // Their Appearance, so the page is drawn in it from the first byte (lib/theme.ts).
  const theme = readTheme(readCookie(request.headers.get("cookie"), THEME_COOKIE));
  return { email, counts, zone, zoneChosen: chosen, margin, spend, paused, theme };
}

export function Layout({ children }: { children: React.ReactNode }) {
  const root = useRouteLoaderData<typeof loader>("root");
  const leaving = useLeaving();
  useSettledForms();
  const theme = useThemeChoice(root?.theme);
  return (
    <html lang="en" data-theme={themeAttribute(theme)}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* The browser bar matches the page: one colour for a chosen theme, the system's for Auto. */}
        {theme === "auto" ? (
          <>
            <meta name="theme-color" media="(prefers-color-scheme: light)" content={THEME_COLOR.light} />
            <meta name="theme-color" media="(prefers-color-scheme: dark)" content={THEME_COLOR.dark} />
          </>
        ) : (
          <meta name="theme-color" content={THEME_COLOR[theme]} />
        )}
        <Meta />
        {/* A stylesheet resource (React 19): drawn in the head once and never
            moved or taken out as pages change, so no page shows unstyled.
            Left to <Links />, it moved between pages and blinked. */}
        <link rel="stylesheet" href={appCss} precedence="default" />
        {/* On every page, so in the head itself rather than <Links />, which moves what it holds between pages.
            The faces are served by sudo itself (@g1t/theme). */}
        <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
        <link rel="preload" href={sansFont} as="font" type="font/woff2" crossOrigin="anonymous" />
        <link rel="preload" href={displayFont} as="font" type="font/woff2" crossOrigin="anonymous" />
        <Links />
      </head>
      <body className="min-h-screen">
        <Progress />
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
          {root?.spend && (
            <div role="alert" className="border-b border-danger/40 bg-danger/12 px-4 py-2 text-sm text-danger">
              <span className="font-medium">Spend cap:</span> {root.spend}{" "}
              <a href="/costs#spend" className="underline underline-offset-2">
                g1t's own spend
              </a>
            </div>
          )}
          {root?.paused && (
            <div role="alert" className="border-b border-danger/40 bg-danger/12 px-4 py-2 text-sm text-danger">
              <span className="font-medium">Platform pause:</span> {root.paused}{" "}
              <a href="/costs#platform" className="underline underline-offset-2">
                Platform pause
              </a>
            </div>
          )}
          <div {...leaving}>{children}</div>
        </div>
        {/* Each takes the page's nonce from ServerRouter (entry.server.tsx). */}
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
      <p className="mt-3 wrap-break-word text-muted">{details}</p>
      <div className="mt-8">
        <ButtonLink to="/" variant="quiet">
          Back to the overview
        </ButtonLink>
      </div>
    </main>
  );
}
