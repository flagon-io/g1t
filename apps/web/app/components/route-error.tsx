import { useEffect, useMemo, useState } from "react";
import { Link, isRouteErrorResponse, useLocation, useMatches, useRevalidator, useRouteLoaderData } from "react-router";

import { clientErrorReport, reportClientError } from "../lib/client-errors";
import { DebugDetails } from "./debug-details";
import { PageMain } from "./landmark";
import { NotFound } from "./not-found";
import { Button } from "./ui/button";
import { ButtonLink } from "./ui";
import { useDeveloperMode } from "../lib/developer-mode";
import { useReconnect } from "../lib/reconnect";
import { isNetworkFailure, tabOutdated } from "../lib/resilient-fetch";
import { RELOADED_KEY, RELOAD_GIVE_UP_MS, clientNavigated, reloadFixes, reloadedBefore } from "../lib/stale-build";
import { isNeedsSignIn } from "../lib/website-token";
import { usePageNavigation } from "../lib/use-page-navigation";

/**
 * What a page shows in place of itself when it failed: the root's error
 * page, and, `contained`, the one a repository's, workspace's or settings'
 * page shows inside its frame (routes/page-boundary.tsx), so its header,
 * tabs and sidebar stay and only the page itself is replaced.
 *
 * A tab left open across a deploy loads the address again, once; no answer
 * from g1t at all keeps trying and comes back by itself (lib/reconnect.ts);
 * a 404 is the not-found page; anything else says what went wrong, with
 * a way to try again, and in developer mode the error in full.
 */
export function RouteError({ error, contained = false }: { error: unknown; contained?: boolean }) {
  const location = useLocation();
  const { owns } = usePageNavigation();
  const matches = useMatches();
  const revalidator = useRevalidator();
  const href = location.pathname + location.search + location.hash;
  // A tab left open across a deploy: load the address again as a whole
  // page, once, rather than show an error the reload fixes. A document load
  // never reloads, so the server and the hydrating client render the same.
  const reloadable = reloadFixes({
    error,
    status: isRouteErrorResponse(error) ? error.status : undefined,
    clientNavigation: clientNavigated(location.key),
    caughtByCatchAll: matches.at(-1)?.id === "routes/not-found",
    outdated: tabOutdated(),
  });
  // Already loaded again once, or the reload never started: show the page.
  const tried = useMemo(() => reloadable && reloadedBefore(href), [reloadable, href]);
  // The error in full, for reporting it (lib/developer-mode.ts).
  const root = useRouteLoaderData("root") as { developer?: boolean } | undefined;
  const developer = useDeveloperMode(root?.developer) || import.meta.env.DEV;
  const [gaveUp, setGaveUp] = useState<string | null>(null);
  const reload = reloadable && !tried && gaveUp !== href;
  // No answer from g1t at all: keep trying, and the page comes back by itself.
  const offline = !reload && isNetworkFailure(error);
  useReconnect(offline);
  useEffect(() => {
    if (!reload || !owns()) return;
    try {
      sessionStorage.setItem(RELOADED_KEY, href);
    } catch {
      // No session storage: reload anyway; a document load never asks again.
    }
    window.location.assign(href);
    const timer = window.setTimeout(() => setGaveUp(href), RELOAD_GIVE_UP_MS);
    return () => window.clearTimeout(timer);
  }, [reload, href, owns]);

  // The error page is about to show: say what it was in the site's logs.
  const shown = !reload && !offline && !(isRouteErrorResponse(error) && error.status === 404);
  useEffect(() => {
    if (shown) reportClientError(clientErrorReport(error, location.pathname, import.meta.env.G1T_BUILD_ID ?? "", tabOutdated()));
  }, [shown, error, location.pathname]);

  const space = contained ? "py-16" : "py-32";
  if (reload) {
    return (
      <PageMain className={`mx-auto max-w-xl px-4 ${space} text-center text-sm text-muted`} aria-busy="true">
        <title>Loading · g1t</title>
        Loading the latest version of g1t…
      </PageMain>
    );
  }

  if (offline) {
    return (
      <PageMain className={`mx-auto max-w-xl px-4 ${space} text-center`} aria-busy="true">
        <title>Reconnecting · g1t</title>
        <h1 className="text-2xl font-semibold tracking-tight">Can't reach g1t</h1>
        <p className="mt-3 text-muted">Check your connection. This page loads by itself once g1t answers.</p>
      </PageMain>
    );
  }

  let title = "Something went wrong";
  let details = contained ? "This page didn't load. The rest of g1t is fine; try again in a moment." : "An unexpected error occurred. Try again in a moment.";

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
  }

  return (
    <PageMain className={`mx-auto px-4 text-center ${developer ? `max-w-3xl ${contained ? "py-10" : "py-16"}` : `max-w-xl ${space}`}`}>
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-3 text-muted">{details}</p>
      <div className="mt-8 flex justify-center gap-2">
        <Button variant="outline" disabled={revalidator.state !== "idle"} onClick={() => void revalidator.revalidate()}>
          {revalidator.state !== "idle" ? "Trying again…" : "Try again"}
        </Button>
        {!contained && (
          <ButtonLink to="/" variant="ghost">
            Back to home
          </ButtonLink>
        )}
      </div>
      {developer ? (
        <DebugDetails error={error} />
      ) : (
        <p className="mt-6 text-xs text-faint">
          Turn on developer mode in{" "}
          <Link to="/settings/account#developer" className="underline underline-offset-4 hover:text-fg">
            Settings
          </Link>{" "}
          to see what went wrong.
        </p>
      )}
    </PageMain>
  );
}
