import { useEffect, useMemo, useRef, useState } from "react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  type ShouldRevalidateFunctionArgs,
  useLocation,
  useMatches,
  useRouteError,
  useRouteLoaderData,
} from "react-router";

import { type User, awaitsConfirmation, hasAccessIn, sharedWorkspaces } from "@g1t/contracts";

import type { Route } from "./+types/root";
import appCss from "./app.css?url";
import displayFont from "@g1t/theme/fonts/bricolage-grotesque-latin.woff2?url";
import sansFont from "@g1t/theme/fonts/hanken-grotesk-latin.woff2?url";
import { ButtonLink } from "./components/ui";
import { AppShell, Progress, type ShellData, useLeaving } from "./components/shell";
import { SiteFooter } from "./components/footer";
import { PublicHeader } from "./components/public-header";
import { SpikeBanner } from "./components/spike-banner";
import { PolicyNotice } from "./components/policy-notice";
import { identify } from "./lib/analytics.client";
import { visitorAsksFirst } from "./lib/analytics-consent";
import { AnalyticsConsent } from "./components/analytics-consent";
import { readCookie } from "./lib/mission";
import { WORKSPACE_COOKIE, workspaceFor } from "./lib/workspace-choice";
import { PageMain } from "./components/landmark";
import { NotFound } from "./components/not-found";
import { frameOf } from "./lib/chrome";
import { DOCK_COOKIE, SIDEBAR_COOKIE, pinsToShow, sidebarClosed } from "./lib/apps";
import { savedPins } from "./lib/dock.server";
import { StandaloneFrame } from "./components/standalone";
import { billing, chat, inbox, projects, workspaceAgents } from "./lib/services.server";
import { unreadTotals } from "./lib/chat";
import { countsFor, readableRepos } from "./lib/access.server";
import { shortCache } from "./lib/cache.server";
import { getViewer, viewerMiddleware } from "./lib/session.server";
import { shortcutOf, workspaceProjects } from "./lib/workspace-projects.server";
import { registrationMode } from "./lib/registration.server";
import { addresses } from "./lib/addresses.server";
import { RELOADED_KEY, RELOAD_GIVE_UP_MS, clientNavigated, reloadFixes, reloadedBefore } from "./lib/stale-build";
import { useNonce } from "./lib/nonce";
import { isNeedsSignIn } from "./lib/website-token";
import { setLiveViaToken } from "./lib/live-socket";
import { LiveNotifications } from "./components/notifications/live-notifications";


export const links: Route.LinksFunction = () => [
  { rel: "icon", href: "/favicon.ico", sizes: "32x32" },
  { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
  { rel: "icon", type: "image/png", sizes: "192x192", href: "/icon-192.png" },
  { rel: "icon", type: "image/png", sizes: "512x512", href: "/icon-512.png" },
  // Home screens and password managers look for a square, opaque 180px tile;
  // the "-precomposed" name is served too, for the ones that ask for it.
  { rel: "apple-touch-icon", sizes: "180x180", href: "/apple-touch-icon.png" },
  // Installable: name, icons and colours for "Add to Home Screen" (public/site.webmanifest;
  // manifest.webmanifest is the same file, kept for installs that already point at it).
  { rel: "manifest", href: "/site.webmanifest" },
  // The text and headline faces are wanted on every page, so they start
  // loading with the stylesheet; mono waits until something uses it.
  { rel: "preload", href: sansFont, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
  { rel: "preload", href: displayFont, as: "font", type: "font/woff2", crossOrigin: "anonymous" },
];

export const middleware: Route.MiddlewareFunction[] = [viewerMiddleware];

export async function loader({ context, params, request }: Route.LoaderArgs) {
  const user = getViewer(context);
  const cookies = request.headers.get("cookie");
  const chosen = readCookie(cookies, WORKSPACE_COOKIE);
  const dock = readCookie(cookies, DOCK_COOKIE);
  // Whether sign-up takes an invite: the sign-up page says so, and
  // Settings → Invites offers invites to g1t only then. Cached per isolate.
  const [shell, mode] = await Promise.all([
    // An account still confirming its address sees only the pages that
    // allows (lib/confirm-gate.ts), in the visitor's frame.
    user && !awaitsConfirmation(user)
      ? shellFor(user, params, chosen, context).catch((error: unknown) => {
          // A sidebar that could not be read is no reason to lose the page,
          // or to draw it as if they were signed out.
          console.error("root: the sidebar could not be read", error);
          return bareShell(user, params, chosen);
        })
      : visitorShell(params, context),
    registrationMode(),
  ]);
  // The apps this person pinned to their dock here: as their account keeps
  // them (read with the rest of the shell), else as this device's cookie
  // remembers them (lib/apps.ts).
  if (shell.workspace) shell.pins = pinsToShow(shell.pins, dock, shell.workspace.slug);
  // Where this g1t lives, for clone lines, agent setup and link previews.
  return {
    user,
    shell,
    // Whether they folded the sidebar away, so the page is drawn that way from the start.
    sidebarClosed: sidebarClosed(readCookie(cookies, SIDEBAR_COOKIE)),
    inviteOnly: mode !== "open",
    addresses: addresses(),
    // Visitors from where the law asks first are asked before analytics runs.
    analyticsConsent: visitorAsksFirst(request),
  };
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

/** The sidebar from what the session already says, with no service asked. */
function bareShell(user: User, params: { owner?: string; repo?: string }, chosen: string | null): ShellData {
  return {
    workspace: workspaceFor(user.workspaces ?? [], chosen, params),
    repos: [],
    repo: null,
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
 * The sidebar: the workspace whose pages or project these are when it is
 * one of yours, else the one you chose (lib/workspace-choice.ts); its
 * projects; and the repository being looked at.
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
  const [listed, counts, status, usage, limit, entitlements, shared, unread, shortcuts, chatUnread, teamAgents, dockPins] = await Promise.all([
    // Every project, for the palette and the count; the sidebar lists only
    // the person's pinned and recent ones (lib/pins.ts).
    workspace ? workspaceProjects(workspace.slug, user) : Promise.resolve(null),
    path ? countsFor(context, params) : Promise.resolve(null),
    // Whether billing is on, without reading the account: that asks the
    // card processor about the workspace's cards, too slow for every page.
    kept("status", () => billing.status()).catch(() => null),
    kept(`usage:${monthStart}`, () => billing.usage(workspace!.slug, user, monthStart)).catch(() => null),
    kept("limit", () => billing.limit(workspace!.slug, user)).catch(() => null),
    kept("entitlements", () => billing.entitlements(workspace!.slug)).catch(() => null),
    sharedRepos(user),
    // The bell's count: one query, never kept, so marking an item shows at once.
    inbox.counts(user.username).catch(() => null),
    // Never kept: opening a project moves it up Recent.
    workspace ? projects.shortcuts(workspace.slug, user).catch(() => null) : Promise.resolve(null),
    // The rail's Chat badge: never kept, and never waited on for long.
    workspace ? chatUnreadFor(workspace.slug, user) : Promise.resolve(null),
    // Home's Recent and the Agents sidebar, on every page: never waited on for long.
    workspace ? agentsFor(workspace.slug, user) : Promise.resolve(null),
    // The dock's pins, kept with the account so every device shows the same
    // dock; never kept here, so a pin shows the moment it is made. Null
    // falls back to the cookie (lib/dock.server.ts).
    workspace ? savedPins(user, workspace.slug) : Promise.resolve(null),
  ]);
  return {
    workspace,
    // Projects are what the sidebar lists: what the workspace builds and runs.
    repos: listed?.ok ? listed.value.map(shortcutOf) : [],
    pinned: (shortcuts?.pinned ?? []).map(shortcutOf),
    recent: (shortcuts?.recent ?? []).map(shortcutOf),
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
      status?.enabled && limit?.ok
        ? {
            exposureMicros: limit.value.exposureMicros,
            ceilingMicros: limit.value.ceilingMicros,
            state: limit.value.state,
            comped: limit.value.trust === "internal",
          }
        : null,
    free: Boolean(status?.free),
    // A spend spike or a hold pauses new compute: the shell says so on every page.
    compute:
      workspace && entitlements && (entitlements.paused || entitlements.spike?.status === "open")
        ? { paused: entitlements.paused, spike: entitlements.spike ?? null, owner: workspace.role === "owner" }
        : null,
    shared,
    inbox: unread,
    chat: chatUnread,
    agents: teamAgents,
    pins: dockPins ?? undefined,
    // While g1t is free every charge is zero, so usage is shown at cost.
    // Usage at price, the one figure every page shows.
    monthUsageMicros: usage?.ok ? (usage.value.free ? usage.value.usedMicros : (usage.value.priceMicros ?? usage.value.spentMicros)) : null,
  };
}

/** Starred and recent conversations Home's sidebar lists. */
const SHELL_CONVERSATIONS = 8;

/**
 * What is unread in chat, for the rail, and the starred and latest
 * conversations, for Home's sidebar; null when chat is slow to answer or
 * does not.
 */
async function chatUnreadFor(slug: string, user: User): Promise<ShellData["chat"]> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), CHAT_BADGE_WAIT_MS));
  const read = chat
    .sidebar(slug, user)
    .then((result) => {
      if (!result.ok) return null;
      const entries = result.value.entries;
      const latest = [...entries].sort((a, b) => (b.channel.last_message_at ?? "").localeCompare(a.channel.last_message_at ?? ""));
      return {
        ...unreadTotals(entries),
        starred: entries.filter((e) => e.starred).slice(0, SHELL_CONVERSATIONS),
        recent: latest.slice(0, SHELL_CONVERSATIONS),
      };
    })
    .catch(() => null);
  return Promise.race([read, timeout]);
}

/** The workspace's agents, as the shell lists them; null when the agents service is slow or down. */
async function agentsFor(slug: string, user: User): Promise<ShellData["agents"]> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), CHAT_BADGE_WAIT_MS));
  const read = workspaceAgents
    .list(slug, user)
    .then((result) =>
      result.ok
        ? result.value
            .filter((agent) => !agent.archived_at)
            .map((agent) => ({
              id: agent.id,
              handle: agent.handle,
              display_name: agent.display_name,
              avatar: agent.avatar,
              avatar_seed: agent.avatar_seed,
              role: agent.role,
              title: agent.title,
              team: agent.team,
              department: agent.department,
              status: agent.status,
              builtin: agent.builtin === true,
            }))
        : null,
    )
    .catch(() => null);
  return Promise.race([read, timeout]);
}

/** The longest the rail's Chat badge holds up a page. */
const CHAT_BADGE_WAIT_MS = 300;

/**
 * How long the sidebar's workspace answers are kept: as long as someone's
 * own changes read fresh anyway (lib/perf.ts `PRIMARY_WINDOW_SECONDS`).
 */
const SHELL_TTL_MS = 30_000;

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

/**
 * The root's data as the browser last had it. When a navigation fails in a
 * way that takes the root's data with it, the error is still drawn in the
 * person's own frame, signed in, not the visitor's. Never kept on the
 * server, where one module serves everyone.
 */
let lastRoot: Awaited<ReturnType<typeof loader>> | undefined;

export function Layout({ children }: { children: React.ReactNode }) {
  const nonce = useNonce();
  // Undefined when the root loader itself failed.
  const loaded = useRouteLoaderData<typeof loader>("root");
  const inBrowser = typeof document !== "undefined";
  if (loaded && inBrowser) lastRoot = loaded;
  const root = loaded ?? (inBrowser ? lastRoot : undefined);
  const user = root?.user;
  // A page opened with an access token signs its live sockets in with tickets (lib/live-socket.ts).
  if (inBrowser) setLiveViaToken(Boolean(user?.token?.website));
  const { pathname, search } = useLocation();
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
  // On the few pages an account still confirming its address can open
  // besides /confirm-email (policies, support, signing in): the way back.
  const verify = user && awaitsConfirmation(user) && pathname !== "/confirm-email" && (
    <p
      role="status"
      className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-warn/30 bg-warn/10 px-4 py-2 text-sm"
    >
      <span>Confirm your email address to start using g1t.</span>
      <Link to="/confirm-email" className="font-medium underline underline-offset-4">
        Enter your code
      </Link>
    </p>
  );
  // A workspace that requires two-factor authentication of someone who
  // has not turned it on: they keep their place, and cannot use it yet.
  const held = user?.held && user.held.length > 0 && pathname !== "/settings/two-factor" && <PolicyNotice held={user.held} />;
  const leaving = useLeaving();
  // Which frame the page is drawn in (lib/chrome.ts): on its own, the app's, or the public one.
  const frame = frameOf(pathname, {
    signedIn: user != null && !awaitsConfirmation(user),
    workspace: (user?.workspaces ?? []).length > 0,
  });
  const banner =
    paused || verify || held ? (
      <>
        {paused}
        {verify}
        {held}
      </>
    ) : null;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <meta name="theme-color" content="#0f0f11" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        {/* The stylesheet before everything React Router preloads, so a slow
            connection paints sooner. */}
        <link rel="stylesheet" href={appCss} precedence="default" />
        {root?.analyticsConsent && <meta name="g1t-analytics" content="consent" />}
        <Meta />
        <Links nonce={nonce} />
      </head>
      <body className="flex min-h-screen flex-col" data-frame={frame === "app" && user && root?.shell ? "app" : frame}>
        {/* The first stop for the keyboard: past the menus, to the page. */}
        <a
          href="#content"
          className="sr-only rounded-md bg-fg px-3 py-2 text-sm font-medium text-bg focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-[70]"
        >
          Skip to content
        </a>
        {frame === "standalone" ? (
          <StandaloneFrame>{children}</StandaloneFrame>
        ) : frame === "app" && user && root?.shell ? (
          <AppShell user={user} shell={root.shell} missing={missing} banner={banner} sidebarClosed={root.sidebarClosed}>
            {children}
          </AppShell>
        ) : (
          <>
            <Progress />
            <PublicHeader user={user} />
            {banner}
            <div id="content" tabIndex={-1} {...leaving} className={`grow outline-none ${leaving.className}`}>
              {children}
            </div>
            <SiteFooter user={user} />
          </>
        )}
        {/* Live notifications for the signed-in: the feed socket, toasts, the tab's count (components/notifications). */}
        {user && !awaitsConfirmation(user) && (
          <LiveNotifications workspace={root?.shell?.workspace?.slug ?? null} inbox={root?.shell?.inbox?.unread ?? null} />
        )}
        <AnalyticsConsent />
        <ScrollRestoration nonce={nonce} />
        <Scripts nonce={nonce} />
      </body>
    </html>
  );
}

export default function App() {
  const userId = useRouteLoaderData<typeof loader>("root")?.user?.id ?? null;
  // Tell analytics who is signed in, once per change; signing out forgets them.
  const lastUserId = useRef<string | null>(null);
  useEffect(() => {
    identify(userId, lastUserId.current);
    lastUserId.current = userId;
  }, [userId]);
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const location = useLocation();
  const matches = useMatches();
  const href = location.pathname + location.search + location.hash;
  // A tab left open across a deploy: load the address again as a whole
  // page, once, rather than show an error the reload fixes. A document load
  // never reloads, so the server and the hydrating client render the same.
  const reloadable = reloadFixes({
    error,
    status: isRouteErrorResponse(error) ? error.status : undefined,
    clientNavigation: clientNavigated(location.key),
    caughtByCatchAll: matches.at(-1)?.id === "routes/not-found",
  });
  // Already loaded again once, or the reload never started: show the page.
  const tried = useMemo(() => reloadable && reloadedBefore(href), [reloadable, href]);
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const reload = reloadable && !tried && gaveUp !== href;
  useEffect(() => {
    if (!reload) return;
    try {
      sessionStorage.setItem(RELOADED_KEY, href);
    } catch {
      // No session storage: reload anyway; a document load never asks again.
    }
    window.location.assign(href);
    const timer = window.setTimeout(() => setGaveUp(href), RELOAD_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [reload, href]);
  if (reload) {
    return (
      <PageMain className="mx-auto max-w-xl px-4 py-32 text-center text-sm text-muted" aria-busy="true">
        <title>Loading · g1t</title>
        Loading the latest version of g1t…
      </PageMain>
    );
  }

  let title = "Something went wrong";
  let details = "An unexpected error occurred. Try again in a moment.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    // The same page for something private and something missing.
    if (error.status === 404) {
      return (
        <>
          <title>Not found · g1t</title>
          <NotFound data={error.data} />
        </>
      );
    }
    if (typeof error.data === "string" && error.data) {
      details = error.data;
    }
    // A token asked for what needs a real sign-in (lib/website-token.ts).
    if (isNeedsSignIn(error.data)) {
      title = "This needs you to sign in";
      details = error.data.message;
    }
  } else if (import.meta.env.DEV && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <PageMain className="mx-auto max-w-xl px-4 py-32 text-center">
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
    </PageMain>
  );
}
